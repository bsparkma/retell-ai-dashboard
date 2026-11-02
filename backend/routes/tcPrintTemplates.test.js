'use strict';

/**
 * CO-3 — print templates: Settings → Print templates, and printing from the
 * checkout workup.
 *
 *   gate       Settings is admin.all (tc, office, hygiene refused); printing is
 *              tc.full (hygiene refused)
 *   defaults   both types work with nothing saved; the letterhead is prefilled
 *              from the office's existing identity
 *   menu       a {{...}} not on the menu is refused at save, by name; so is a
 *              stray brace and a placeholder in the letterhead; nothing stored
 *   save       read back; audited inside the save (prior_state default|stored)
 *   isolation  roland's template never reaches valley, and a roland card is not
 *              printable through ?office=valley
 *   logo       no storage → 503 "Logo storage is not set up for this
 *              environment", nothing stored; a missing container → the same;
 *              type and size limits; with storage, the PDF carries it
 *   print      the PDF holds the filled values for a fixture card; the body can
 *              name no patient, office, provider or day; one audit row per
 *              print, and NO PDF when it cannot be written; nothing stored, no
 *              Open Dental call
 *
 * Test patients only (roland 12827, valley 7115); names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { before, after, beforeEach, afterEach } = test;
const zlib = require('node:zlib');
const express = require('express');
const { randomUUID } = require('node:crypto');

const registry = require('../platform/registry');
const tenantDb = require('../platform/tenantDb');
const userContext = require('../platform/userContext');
const odOffices = require('../config/odOffices');
const tcCheckout = require('../config/tcCheckout');
const { tenantContext } = require('../middleware/tenantContext');
const { requirePermission } = require('../config/permissions');
const checkoutRoute = require('./tc/checkout');
const checkoutStore = require('./tc/checkoutStore');
const assets = require('../services/tc/printAssetStore');
const contract = require('../tc/contract.gen.cjs');
const { bootTcApp, api, auditRows, FakeTenantDb } = require('./tc/tcTestUtils');

const NOW = new Date('2026-10-30T15:00:00.000Z');
const TODAY = '2026-10-30';
const SETTINGS = '/api/platform/print-templates';

const ENV = {
  TC_EMAIL_PRACTICE_NAME_ROLAND: 'Synthetic Roland Dental',
  TC_EMAIL_PRACTICE_PHONE_ROLAND: '(555) 010-0001',
  TC_EMAIL_PRACTICE_ADDRESS_ROLAND: '1 Example Way, Roland, OK',
  TC_EMAIL_PRACTICE_NAME_VALLEY: 'Synthetic Valley Dental',
  TC_EMAIL_PRACTICE_PHONE_VALLEY: '(555) 010-0002',
  TC_EMAIL_PRACTICE_ADDRESS_VALLEY: '2 Example Way, Fort Smith, AR',
  TC_CHECKOUT_ENABLED_ROLAND: 'true',
  TC_CHECKOUT_ENABLED_VALLEY: 'true',
  OPENDENTAL_CUSTOMER_KEY: 'test-roland-customer-key',
  OPENDENTAL_CUSTOMER_KEY_VALLEY: 'test-valley-customer-key',
};
const savedEnv = {};
let savedGetPlatformSetting;
let odCalls = [];
let patched = [];

before(() => {
  for (const k of [...Object.keys(ENV), 'TC_BLOB_ACCOUNT_URL', 'OPENDENTAL_ALLOW_MOCK']) savedEnv[k] = process.env[k];
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
  registry.getPlatformSetting = savedGetPlatformSetting;
  odOffices.resetOdOfficeCache();
  tcCheckout.resetCacheForTests();
});
beforeEach(() => {
  delete process.env.TC_BLOB_ACCOUNT_URL;
  assets.resetForTests();
  // No control plane: no stored identity, no stored switch row — the env answers.
  registry.getPlatformSetting = async () => null;
  tcCheckout.resetCacheForTests();
  checkoutRoute.setClockForTests(() => NOW);
  odCalls = [];
  patched = [];
  // Any Open Dental call at all is a failure of this module's promise.
  for (const office of ['roland', 'valley']) {
    const { client } = odOffices.getOdOffice(office);
    patched.push({ client, original: client.apiGetRaw });
    client.apiGetRaw = async (p) => {
      odCalls.push({ office, path: p });
      return { ok: false, status: 500, data: null, error: 'no Open Dental in this test' };
    };
  }
});
afterEach(() => {
  for (const { client, original } of patched) client.apiGetRaw = original;
  checkoutRoute.setClockForTests(null);
  assets.resetForTests();
});

/** Settings, mounted exactly as server.js mounts it, with real tenant + permission gates. */
async function bootSettings(t, { role = 'admin', db = new FakeTenantDb() } = {}) {
  const keys = ['getUserByEmail', 'getTenantById', 'getTenantClinics', 'getEnabledModules', 'getPlatformAdminByEmail', 'touchUserLogin'];
  const orig = Object.fromEntries(keys.map((k) => [k, registry[k]]));
  const origDb = tenantDb.withTenantDb;
  registry.getUserByEmail = async () => ({ user_id: 'U1', tenant_id: 'T1', email: 'om@carein.ai', role, status: 'active' });
  registry.getTenantById = async () => ({ tenant_id: 'T1', slug: 'carein', display_name: 'CareIN', status: 'active' });
  registry.getTenantClinics = async () => [];
  registry.getEnabledModules = async () => ['tc'];
  registry.getPlatformAdminByEmail = async () => null;
  registry.touchUserLogin = async () => {};
  userContext.clearCache();
  tenantDb.withTenantDb = async (_req, fn) => fn(db);
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { email: 'om@carein.ai', name: 'Office Manager', tenantId: 'T1' };
    next();
  });
  app.use('/api', tenantContext());
  app.use('/api/platform/print-templates', requirePermission('admin.all'), require('./printTemplates'));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  let closed = false;
  const close = () =>
    new Promise((r) => {
      if (closed) return r();
      closed = true;
      for (const k of keys) registry[k] = orig[k];
      tenantDb.withTenantDb = origDb;
      server.close(() => r());
    });
  t.after(close);
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, db, close };
}

async function bootTc(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

/** POST with a multipart file. */
async function upload(baseUrl, path, bytes, name = 'logo.png') {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** POST JSON, keep the raw bytes (a PDF) and the headers. */
async function postRaw(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
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

/** A real (tiny, RGBA) PNG. */
function png() {
  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (const b of buf) {
      let c = (crc ^ b) & 0xff;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.concat([Buffer.from([0]), Buffer.alloc(16, 200), Buffer.from([0]), Buffer.alloc(16, 90)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A checkout card for a fixture patient, as the store holds it. */
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

const templateAudits = (db) => auditRows(db).filter((a) => a.resource_type === 'tc_print_template');
const printAudits = (db) => auditRows(db).filter((a) => a.resource_type === 'tc_checkout_print');

// ── 1. Settings: the gate ───────────────────────────────────────────────────

test('Settings is admin.all: tc, office and hygiene are refused 403 before anything is read or written', async (t) => {
  for (const role of ['tc', 'office', 'hygiene', 'doctor']) {
    const { baseUrl, db } = await bootSettings(t, { role });
    assert.equal((await api(baseUrl, 'GET', `${SETTINGS}?office=roland`)).status, 403, role);
    const put = await api(baseUrl, 'PUT', `${SETTINGS}/excuse?office=roland`, contract.defaultPrintTemplate('excuse', { name: 'x', address: '', phone: '' }));
    assert.equal(put.status, 403, role);
    assert.equal(db.table('tc_print_templates').length, 0);
  }
  const { baseUrl } = await bootSettings(t, { role: 'admin' });
  assert.equal((await api(baseUrl, 'GET', `${SETTINGS}?office=roland`)).status, 200);
});

test('the office is a frozen key: missing or unknown is a 400', async (t) => {
  const { baseUrl } = await bootSettings(t);
  for (const q of ['', '?office=unknown', '?office=Roland']) {
    const r = await api(baseUrl, 'GET', `${SETTINGS}${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.body.code, 'INVALID_OFFICE');
  }
});

// ── 2. Defaults ─────────────────────────────────────────────────────────────

test('defaults: both types work with nothing saved, the letterhead prefilled from the office identity', async (t) => {
  const { baseUrl } = await bootSettings(t);
  const r = await api(baseUrl, 'GET', `${SETTINGS}?office=roland`);
  const body = contract.PrintTemplatesResponse.parse(r.body);
  assert.deepEqual(body.prefill, { name: 'Synthetic Roland Dental', address: '1 Example Way, Roland, OK', phone: '(555) 010-0001' });
  assert.deepEqual(body.templates.map((x) => [x.type, x.stored]), [
    ['excuse', false],
    ['appointment_card', false],
  ]);
  for (const x of body.templates) {
    assert.deepEqual(x.fields, contract.defaultPrintTemplate(x.type, body.prefill));
    assert.deepEqual(contract.validatePrintTemplate(x.fields), [], `${x.type} default passes its own menu`);
  }
  assert.equal(body.logoStorageConfigured, false);
});

// ── 3. The menu ─────────────────────────────────────────────────────────────

test('a placeholder not on the menu is refused at save, by name, and nothing is stored', async (t) => {
  const { baseUrl, db } = await bootSettings(t);
  const base = contract.defaultPrintTemplate('excuse', { name: 'Synthetic Roland Dental', address: '', phone: '' });

  const unknown = await api(baseUrl, 'PUT', `${SETTINGS}/excuse?office=roland`, { ...base, body: 'Seen on {{date_seen}}. DOB {{patient_dob}}.' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'PRINT_TEMPLATE_UNKNOWN_PLACEHOLDER');
  assert.match(unknown.body.error, /\{\{patient_dob\}\}/);
  assert.equal(unknown.body.field, 'body');

  const sig = await api(baseUrl, 'PUT', `${SETTINGS}/excuse?office=roland`, { ...base, signatureLine: '{{ssn}}' });
  assert.equal(sig.body.code, 'PRINT_TEMPLATE_UNKNOWN_PLACEHOLDER');
  assert.equal(sig.body.field, 'signatureLine');

  const stray = await api(baseUrl, 'PUT', `${SETTINGS}/excuse?office=roland`, { ...base, body: 'Seen {{date_seen}} and {{ patient' });
  assert.equal(stray.body.code, 'PRINT_TEMPLATE_MALFORMED_PLACEHOLDER');

  const inLetterhead = await api(baseUrl, 'PUT', `${SETTINGS}/excuse?office=roland`, { ...base, letterheadName: '{{office_name}}' });
  assert.equal(inLetterhead.body.code, 'PRINT_TEMPLATE_PLACEHOLDER_NOT_ALLOWED_HERE');

  const extraKey = await api(baseUrl, 'PUT', `${SETTINGS}/excuse?office=roland`, { ...base, office: 'valley' });
  assert.equal(extraKey.status, 400, 'a body cannot name an office');

  assert.equal(db.table('tc_print_templates').length, 0);
  assert.equal(templateAudits(db).length, 0);
});

test('the renderer reaches nothing outside the menu, even for a token that slipped past', () => {
  const values = Object.fromEntries(contract.PRINT_PLACEHOLDERS.map((k) => [k, `<${k}>`]));
  values.patient_dob = 'NEVER';
  const out = contract.fillPlaceholders('{{patient_full_name}} {{patient_dob}} {{constructor}}', values);
  assert.equal(out, '<patient_full_name> {{patient_dob}} {{constructor}}');
});

// ── 4. Save: read back, audited, office isolation ───────────────────────────

test('save: read back, audited (default then stored), and only in its own office', async (t) => {
  const { baseUrl, db } = await bootSettings(t);
  const fields = {
    ...contract.defaultPrintTemplate('excuse', { name: 'Synthetic Roland Dental', address: '1 Example Way', phone: '(555) 010-0001' }),
    body: 'Please excuse {{patient_full_name}}, seen {{date_seen}}.',
  };
  const first = await api(baseUrl, 'PUT', `${SETTINGS}/excuse?office=roland`, fields);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const saved = contract.PrintTemplateSaveResponse.parse(first.body).template;
  assert.equal(saved.stored, true);
  assert.deepEqual(saved.fields, fields);
  assert.equal(saved.updatedBy, 'om@carein.ai');

  const second = await api(baseUrl, 'PUT', `${SETTINGS}/excuse?office=roland`, { ...fields, heading: 'Excuse note' });
  assert.equal(second.status, 200);
  assert.deepEqual(
    templateAudits(db).map((a) => [a.action, a.resource_id, a.office, a.prior_state]),
    [
      ['UPDATE', 'roland:excuse', 'roland', 'default'],
      ['UPDATE', 'roland:excuse', 'roland', 'stored'],
    ]
  );
  assert.ok(!JSON.stringify(templateAudits(db)).includes('Please excuse'), 'the wording never goes into the trail');

  // Valley is untouched: still the shipped default, with valley's letterhead.
  const valley = contract.PrintTemplatesResponse.parse((await api(baseUrl, 'GET', `${SETTINGS}?office=valley`)).body);
  const vEx = valley.templates.find((x) => x.type === 'excuse');
  assert.equal(vEx.stored, false);
  assert.equal(vEx.fields.letterheadName, 'Synthetic Valley Dental');
  assert.deepEqual(db.table('tc_print_templates').map((r) => [r.office_id, r.template_type]), [['roland', 'excuse']]);
});

test('a save whose read-back differs is not reported as saved', async (t) => {
  const { baseUrl, db } = await bootSettings(t);
  db.onQuery(/^SELECT office_id, template_type, heading/, () => ({ rows: [] }));
  const fields = contract.defaultPrintTemplate('excuse', { name: 'x', address: '', phone: '' });
  const r = await api(baseUrl, 'PUT', `${SETTINGS}/excuse?office=roland`, fields);
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 'SAVE_NOT_CONFIRMED');
});

test('an audit write that fails rolls the save back (fail closed)', async (t) => {
  const { baseUrl, db } = await bootSettings(t);
  db.onQuery(/^INSERT INTO audit_log/, () => {
    throw new Error('audit store down');
  });
  const statements = [];
  const conn = db.connect.bind(db);
  db.connect = async () => {
    const c = await conn();
    return { ...c, query: (sql, params) => (statements.push(String(sql).trim().split(/\s+/)[0]), c.query(sql, params)) };
  };
  const r = await api(baseUrl, 'PUT', `${SETTINGS}/excuse?office=roland`, contract.defaultPrintTemplate('excuse', { name: 'x', address: '', phone: '' }));
  assert.equal(r.status, 500);
  assert.ok(statements.includes('ROLLBACK') && !statements.includes('COMMIT'), statements.join(','));
});

// ── 5. Logo ─────────────────────────────────────────────────────────────────

test('logo: with no storage configured, 503 "Logo storage is not set up for this environment" and nothing stored', async (t) => {
  const { baseUrl, db } = await bootSettings(t);
  const r = await upload(baseUrl, `${SETTINGS}/excuse/logo?office=roland`, png());
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'PRINT_LOGO_STORAGE_UNAVAILABLE');
  assert.match(r.body.error, /^Logo storage is not set up for this environment/);
  assert.equal(db.table('tc_print_templates').length, 0);
  assert.equal(templateAudits(db).length, 0);
});

test('logo: storage configured but the container does not exist yet → the same refusal, nothing stored', async (t) => {
  process.env.TC_BLOB_ACCOUNT_URL = 'https://example.invalid';
  assets.setContainerClientForTests({
    getBlockBlobClient: () => ({
      uploadData: async () => {
        throw Object.assign(new Error('The specified container does not exist.'), { code: 'ContainerNotFound', statusCode: 404 });
      },
    }),
  });
  const { baseUrl, db } = await bootSettings(t);
  const r = await upload(baseUrl, `${SETTINGS}/excuse/logo?office=roland`, png());
  assert.equal(r.status, 503);
  assert.match(r.body.error, /^Logo storage is not set up for this environment/);
  assert.equal(db.table('tc_print_templates').length, 0);
});

test('logo: only PNG or JPEG, at most 2 MB', async (t) => {
  process.env.TC_BLOB_ACCOUNT_URL = 'https://example.invalid';
  assets.setContainerClientForTests({ getBlockBlobClient: () => ({ uploadData: async () => assert.fail('nothing uploads') }) });
  const { baseUrl } = await bootSettings(t);
  const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(20)]);
  const notImage = await upload(baseUrl, `${SETTINGS}/excuse/logo?office=roland`, gif, 'logo.png');
  assert.equal(notImage.status, 415);
  assert.equal(notImage.body.code, 'LOGO_TYPE_NOT_ALLOWED');
  const big = Buffer.concat([png(), Buffer.alloc(2 * 1024 * 1024)]);
  const tooBig = await upload(baseUrl, `${SETTINGS}/excuse/logo?office=roland`, big);
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.code, 'LOGO_TOO_LARGE');
});

// ── 6. Printing ─────────────────────────────────────────────────────────────

const PRINT = (id, office = 'roland') => `/api/tc/checkout/${id}/print?office=${office}`;

test('printing is tc.full: a hygienist is refused, and no audit row is written', async (t) => {
  const db = new FakeTenantDb();
  const card = seedCard(db);
  const { baseUrl } = await bootTc(t, { role: 'hygiene', db });
  assert.equal((await api(baseUrl, 'GET', PRINT(card.handoff_id))).status, 403);
  const r = await postRaw(baseUrl, PRINT(card.handoff_id), { templateType: 'excuse' });
  assert.equal(r.status, 403);
  assert.equal(printAudits(db).length, 0);
});

test('the print dialog: the card\'s own patient, day, provider and office; next appointment pre-filled from the anchor', async (t) => {
  const db = new FakeTenantDb();
  const card = seedCard(db, {
    status: 'scheduled',
    outcome_by: 'tc@carein.ai',
    outcome_at: NOW,
    appt_num: 5001,
    appt_at_local: '2026-11-04 13:30:00',
    appt_snapshot: JSON.stringify({ dateTime: '2026-11-04 13:30:00', provider: 'DOC1', appointmentType: 'Crown', operatory: 'Op 3' }),
    appt_linked_by: 'tc@carein.ai',
    appt_linked_at: NOW,
  });
  const { baseUrl } = await bootTc(t, { role: 'tc', db });
  const r = await api(baseUrl, 'GET', PRINT(card.handoff_id));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = contract.TcCheckoutPrintDefaults.parse(r.body);
  assert.deepEqual(d.fixed, { patientFullName: 'Stedi Test 2', dateSeen: 'October 30, 2026', providerName: 'DOC1', officeName: 'Synthetic Roland Dental' });
  assert.deepEqual(d.editable, { timeSeenRange: '', nextAppointmentDate: 'Wednesday, November 4, 2026', nextAppointmentTime: '1:30 PM' });
  assert.deepEqual(d.templates.map((x) => x.type), ['excuse', 'appointment_card']);
});

test('the PDF holds the filled values for a known fixture card — and the audit row, and nothing else', async (t) => {
  const db = new FakeTenantDb();
  const card = seedCard(db);
  const before = JSON.stringify(db.table('tc_checkout_handoffs'));
  const { baseUrl } = await bootTc(t, { role: 'tc', db });

  const r = await postRaw(baseUrl, PRINT(card.handoff_id), {
    templateType: 'excuse',
    timeSeenRange: '9:00 AM - 10:00 AM',
    nextAppointmentDate: '',
    nextAppointmentTime: '',
  });
  assert.equal(r.status, 200, r.buf.toString('utf8').slice(0, 200));
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.headers.get('x-print-logo'), 'none');
  assert.equal(r.buf.subarray(0, 5).toString('latin1'), '%PDF-');
  const text = await pdfText(r.buf);
  for (const expected of [
    'Synthetic Roland Dental',
    '1 Example Way, Roland, OK',
    '(555) 010-0001',
    'School / Work Excuse',
    'Stedi Test 2 was seen in our office on October 30, 2026 (9:00 AM - 10:00 AM)',
    'please call us at (555) 010-0001',
    'DOC1, Synthetic Roland Dental',
  ]) {
    assert.ok(text.includes(expected), `PDF lacks "${expected}": ${text}`);
  }

  assert.deepEqual(
    printAudits(db).map((a) => [a.action, a.resource_id, a.office, a.source_ref, a.user_id]),
    [['READ', card.handoff_id, 'roland', 'template:excuse|patient:12827', 'tc@carein.ai']]
  );
  assert.equal(JSON.stringify(db.table('tc_checkout_handoffs')), before, 'nothing is stored on the card');
  assert.equal(db.table('tc_print_templates').length, 0);
  assert.deepEqual(odCalls, [], 'no Open Dental call');
});

test('the appointment card prints the edited next appointment, and a blank prints as a line to write on', async (t) => {
  const db = new FakeTenantDb();
  const card = seedCard(db);
  const { baseUrl } = await bootTc(t, { role: 'tc', db });
  const r = await postRaw(baseUrl, PRINT(card.handoff_id), { templateType: 'appointment_card', nextAppointmentDate: 'Friday, December 4, 2026' });
  assert.equal(r.status, 200);
  const text = await pdfText(r.buf);
  assert.ok(text.includes('Stedi, we look forward to seeing you again.'), text);
  assert.ok(text.includes(`Friday, December 4, 2026 at ${contract.PRINT_BLANK}`), text);
});

test('the request cannot name a patient, an office, a provider or a day', async (t) => {
  const db = new FakeTenantDb();
  const card = seedCard(db);
  const { baseUrl } = await bootTc(t, { role: 'tc', db });
  for (const extra of [{ patientName: 'Someone Else' }, { office: 'valley' }, { providerName: 'X' }, { dateSeen: '2020-01-01' }, { odPatientId: 7115 }]) {
    const r = await postRaw(baseUrl, PRINT(card.handoff_id), { templateType: 'excuse', ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
  const unknownType = await postRaw(baseUrl, PRINT(card.handoff_id), { templateType: 'invoice' });
  assert.equal(unknownType.status, 400);
  assert.equal(printAudits(db).length, 0);
});

test('fail closed: when the print cannot be audited, no PDF is sent', async (t) => {
  const db = new FakeTenantDb();
  const card = seedCard(db);
  db.onQuery(/^INSERT INTO audit_log/, () => {
    throw new Error('audit store down');
  });
  const { baseUrl } = await bootTc(t, { role: 'tc', db });
  const r = await postRaw(baseUrl, PRINT(card.handoff_id), { templateType: 'excuse' });
  assert.equal(r.status, 500);
  assert.notEqual(r.buf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.equal(JSON.parse(r.buf.toString('utf8')).code, 'PRINT_AUDIT_FAILED');
});

test('office isolation: a roland card is not printable through valley; a valley card prints valley\'s letterhead', async (t) => {
  const db = new FakeTenantDb();
  const roland = seedCard(db);
  const valley = seedCard(db, { office_id: 'valley', od_patient_id: 7115, patient_name: 'TestValley, Stedi' });
  const { baseUrl } = await bootTc(t, { role: 'tc', db });
  const cross = await postRaw(baseUrl, PRINT(roland.handoff_id, 'valley'), { templateType: 'excuse' });
  assert.equal(cross.status, 404);
  const v = await postRaw(baseUrl, PRINT(valley.handoff_id, 'valley'), { templateType: 'excuse' });
  assert.equal(v.status, 200);
  const text = await pdfText(v.buf);
  assert.ok(text.includes('Synthetic Valley Dental') && text.includes('Stedi TestValley'), text);
  assert.ok(!text.includes('Roland'), text);
  assert.deepEqual(printAudits(db).map((a) => [a.office, a.source_ref]), [['valley', 'template:excuse|patient:7115']]);
});

test('a saved template is what prints', async (t) => {
  const db = new FakeTenantDb();
  const card = seedCard(db);
  db.table('tc_print_templates').push({
    office_id: 'roland',
    template_type: 'excuse',
    heading: 'Attendance note',
    letterhead_name: 'Synthetic Roland Dental (edited)',
    letterhead_address: '',
    letterhead_phone: '',
    body: '{{patient_first_name}} attended on {{date_seen}}.',
    signature_line: '',
    logo_key: null,
    logo_content_type: null,
    updated_by: 'om@carein.ai',
    updated_at: NOW,
  });
  const { baseUrl } = await bootTc(t, { role: 'tc', db });
  const text = await pdfText((await postRaw(baseUrl, PRINT(card.handoff_id), { templateType: 'excuse' })).buf);
  assert.ok(text.includes('Synthetic Roland Dental (edited)') && text.includes('Attendance note') && text.includes('Stedi attended on October 30, 2026.'), text);
});

test('with storage, the logo is uploaded, audited, and carried into the printout; unreadable, it is left off and says so', async (t) => {
  process.env.TC_BLOB_ACCOUNT_URL = 'https://example.invalid';
  const blobs = new Map();
  assets.setContainerClientForTests({
    getBlockBlobClient: (key) => ({
      uploadData: async (data) => {
        blobs.set(key, Buffer.from(data));
      },
      downloadToBuffer: async () => {
        if (!blobs.has(key)) throw Object.assign(new Error('gone'), { statusCode: 404 });
        return blobs.get(key);
      },
    }),
  });
  const db = new FakeTenantDb();
  const settings = await bootSettings(t, { db });
  const up = await upload(settings.baseUrl, `${SETTINGS}/excuse/logo?office=roland`, png());
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.template.logo.present, true);
  assert.equal(up.body.template.stored, true, 'a row with the shipped wording now holds the logo');
  assert.deepEqual(templateAudits(db).map((a) => a.prior_state), ['logo_none']);
  const [row] = db.table('tc_print_templates');
  assert.match(row.logo_key, /^tenant\/carein\/tc\/print-logo-roland\/[0-9a-f-]{36}\.png$/);
  // One harness at a time: each restores the registry stubs it replaced.
  await settings.close();

  const card = seedCard(db);
  const tc = await bootTc(t, { role: 'tc', db });
  const withLogo = await postRaw(tc.baseUrl, PRINT(card.handoff_id), { templateType: 'excuse' });
  assert.equal(withLogo.headers.get('x-print-logo'), 'included');
  assert.ok(withLogo.buf.toString('latin1').includes('/Subtype /Image'), 'the image is in the PDF');

  blobs.clear();
  const omitted = await postRaw(tc.baseUrl, PRINT(card.handoff_id), { templateType: 'excuse' });
  assert.equal(omitted.status, 200);
  assert.equal(omitted.headers.get('x-print-logo'), 'omitted');
  assert.ok(!omitted.buf.toString('latin1').includes('/Subtype /Image'));
});
