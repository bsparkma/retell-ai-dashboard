'use strict';

/**
 * CO-3b — print template styling. Beau's ruling 2026-11-02: curated options
 * only, no free-form designer.
 *
 *   refusals   an unknown key, a bad hex, a too-light accent, an option not on
 *              the list, a missing key, a malformed envelope — each 400 BY
 *              NAME, nothing stored, no audit row
 *   save       read back; audited inside the save (prior_state style_default
 *              then style_set); the standard style is stored as NULL
 *   gate       admin.all, like the rest of Settings
 *   isolation  roland's styling never reaches valley's printout
 *   PDF        every layout, font pair, logo placement and size: the PDF's
 *              content stream IS the layout engine's operations (the preview
 *              draws the same ones — tests/tc-print-styling.test.tsx), with
 *              geometry asserted on the PDF itself; the accent only on the
 *              letterhead; a bundled pair embedded as TrueType; text extracts
 *   defaults   a template with NULL styling prints the pinned CO-3 bytes
 *   fonts      the preview's font route serves the allow-listed files only
 *
 * Test patients only (roland 12827, valley 7115); names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { before, after, beforeEach, afterEach } = test;
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
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
const assets = require('../services/tc/printAssetStore');
const contract = require('../tc/contract.gen.cjs');
const { renderPrintPdf } = require('../services/tc/printPdf');
const { prepareLogo } = require('../services/tc/printImage');
const { FONT_DIR } = require('../services/tc/printFonts');
const { bootTcApp, api, auditRows, FakeTenantDb } = require('./tc/tcTestUtils');
const { PINNED_DOCS, PINNED_SHA256, png } = require('../test/fixtures/printPdfPins');

const NOW = new Date('2026-10-30T15:00:00.000Z');
const SETTINGS = '/api/platform/print-templates';
const PRINT = (id, office = 'roland') => `/api/tc/checkout/${id}/print?office=${office}`;
const { width: W, height: H, margin: M } = contract.PRINT_PAGE;

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
  registry.getPlatformSetting = async () => null;
  tcCheckout.resetCacheForTests();
  checkoutRoute.setClockForTests(() => NOW);
  odCalls = [];
  patched = [];
  // No Open Dental call at all, anywhere in this module.
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

/** Settings, mounted as server.js mounts it, with the real tenant + permission gates. */
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

async function postRaw(baseUrl, p, body) {
  const res = await fetch(`${baseUrl}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
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
    visit_date: '2026-10-30',
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

const styleAudits = (db) => auditRows(db).filter((a) => a.resource_type === 'tc_print_template');
const style = (over = {}) => ({ ...contract.PRINT_STYLING_DEFAULTS, ...over });
const putStyling = (baseUrl, body, { type = 'excuse', office = 'roland' } = {}) =>
  api(baseUrl, 'PUT', `${SETTINGS}/${type}/styling?office=${office}`, body);

/**
 * The PDF's content streams, parsed back into the engine's op shape, per page.
 * Only the forms printPdf.js writes are recognised; anything else fails.
 */
function pdfOps(buf) {
  const s = buf.toString('latin1');
  const pages = [];
  const re = /\d+ 0 obj\n<< {2}\/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(s))) {
    const body = s.slice(m.index + m[0].length, m.index + m[0].length + Number(m[1]));
    pages.push(
      body.split('\n').map((line) => {
        let x;
        if ((x = /^(?:q ([\d.]+) ([\d.]+) ([\d.]+) rg )?BT \/(F[12]) ([\d.]+) Tf 1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm \((.*)\) Tj ET(?: Q)?$/.exec(line))) {
          return { kind: 'text', rgb: x[1] ? [x[1], x[2], x[3]].map(Number) : null, font: x[4], size: Number(x[5]), x: Number(x[6]), y: Number(x[7]), text: x[8].replace(/\\([\\()])/g, '$1') };
        }
        if ((x = /^(?:q ([\d.]+) ([\d.]+) ([\d.]+) RG )?0\.6 w (-?[\d.]+) (-?[\d.]+) m (-?[\d.]+) (-?[\d.]+) l S(?: Q)?$/.exec(line))) {
          return { kind: 'rule', rgb: x[1] ? [x[1], x[2], x[3]].map(Number) : null, x1: Number(x[4]), x2: Number(x[6]), y: Number(x[5]) };
        }
        if ((x = /^q ([\d.]+) 0 0 ([\d.]+) (-?[\d.]+) (-?[\d.]+) cm \/Im1 Do Q$/.exec(line))) {
          return { kind: 'image', w: Number(x[1]), h: Number(x[2]), x: Number(x[3]), y: Number(x[4]) };
        }
        if ((x = /^q 0\.55 G 0\.8 w (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re S Q$/.exec(line))) {
          return { kind: 'frame', x: Number(x[1]), y: Number(x[2]), w: Number(x[3]), h: Number(x[4]) };
        }
        throw new Error(`unrecognised content op: ${line}`);
      })
    );
  }
  return pages;
}

const r2 = (v) => Number(v.toFixed(2));
const hexRgb = (hex) => [1, 3, 5].map((i) => Number((parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)));

/** Every op in the PDF equals the engine's op, at the PDF's two-decimal precision. */
function assertPdfIsLayout(buf, layout, label) {
  const got = pdfOps(buf);
  assert.equal(got.length, layout.pages.length, `${label}: page count`);
  layout.pages.forEach((ops, p) => {
    assert.equal(got[p].length, ops.length, `${label}: op count on page ${p + 1}`);
    ops.forEach((op, i) => {
      const g = got[p][i];
      assert.equal(g.kind, op.kind, `${label}: op ${i} kind`);
      if (op.kind === 'text') {
        assert.deepEqual([g.font, g.size, g.x, g.y, g.text], [op.slot === 'heading' ? 'F2' : 'F1', op.size, r2(op.x), r2(op.y), op.text], `${label}: "${op.text}"`);
        assert.deepEqual(g.rgb, op.color ? hexRgb(op.color) : null, `${label}: colour of "${op.text}"`);
      } else if (op.kind === 'rule') {
        assert.deepEqual([g.x1, g.x2, g.y], [r2(op.x1), r2(op.x2), r2(op.y)], `${label}: rule`);
        assert.deepEqual(g.rgb, op.color ? hexRgb(op.color) : null, `${label}: rule colour`);
      } else if (op.kind === 'image') {
        assert.deepEqual([g.x, g.y, g.w, g.h], [r2(op.x), r2(op.y), r2(op.w), r2(op.h)], `${label}: logo`);
      } else {
        assert.deepEqual([g.x, g.y, g.w, g.h], [op.x, op.y, op.w, op.h], `${label}: frame`);
      }
    });
  });
  return got;
}

// ── refusals ────────────────────────────────────────────────────────────────

test('refused by name — unknown key, bad hex, too-light accent, unknown option, missing key, bad envelope — nothing stored, nothing audited', async (t) => {
  const { baseUrl, db } = await bootSettings(t);
  const { layout: _l, ...missing } = contract.PRINT_STYLING_DEFAULTS;
  const cases = [
    [{ styling: { ...style(), bodyColor: '#ff0000' } }, 'PRINT_STYLE_UNKNOWN_KEY'],
    [{ styling: style({ accentColor: 'navy' }) }, 'PRINT_STYLE_INVALID_COLOR'],
    [{ styling: style({ accentColor: '#fff' }) }, 'PRINT_STYLE_INVALID_COLOR'],
    [{ styling: style({ accentColor: '#ffff00' }) }, 'PRINT_STYLE_ACCENT_TOO_LIGHT'],
    [{ styling: style({ accentColor: '#777777' }) }, 'PRINT_STYLE_ACCENT_TOO_LIGHT'],
    [{ styling: style({ fontPair: 'comic_sans' }) }, 'PRINT_STYLE_UNKNOWN_OPTION'],
    [{ styling: style({ logoPlacement: 'top' }) }, 'PRINT_STYLE_UNKNOWN_OPTION'],
    [{ styling: missing }, 'PRINT_STYLE_MISSING_KEY'],
    [{ styling: 'classic' }, 'PRINT_STYLE_NOT_AN_OBJECT'],
    [{ styling: style(), office: 'valley' }, 'INVALID_BODY'],
    [{}, 'INVALID_BODY'],
  ];
  for (const [body, code] of cases) {
    const r = await putStyling(baseUrl, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, code, JSON.stringify(body));
  }
  const tooLight = await putStyling(baseUrl, { styling: style({ accentColor: '#ffff00' }) });
  assert.match(tooLight.body.error, /too light to read on white paper/);
  assert.equal(db.table('tc_print_templates').length, 0);
  assert.equal(styleAudits(db).length, 0);
});

test('Settings styling is admin.all: tc, office, hygiene and doctor are refused 403 before anything is written', async (t) => {
  for (const role of ['tc', 'office', 'hygiene', 'doctor']) {
    const { baseUrl, db } = await bootSettings(t, { role });
    assert.equal((await putStyling(baseUrl, { styling: style({ layout: 'centered_formal' }) })).status, 403, role);
    assert.equal((await api(baseUrl, 'GET', `${SETTINGS}/fonts/Lato-Regular.ttf?office=roland`)).status, 403, role);
    assert.equal(db.table('tc_print_templates').length, 0, role);
  }
});

// ── save, audit, read-back ──────────────────────────────────────────────────

test('save: read back, audited inside the save (style_default then style_set), lower-cased; the standard style is stored as NULL', async (t) => {
  const { baseUrl, db } = await bootSettings(t);
  const chosen = style({ accentColor: '#1F4E79', fontPair: 'traditional', layout: 'centered_formal', logoPlacement: 'center', logoSize: 'small' });
  const first = await putStyling(baseUrl, { styling: chosen });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const state = contract.PrintTemplateSaveResponse.parse(first.body).template;
  assert.deepEqual(state.styling, { ...chosen, accentColor: '#1f4e79' });
  assert.equal(state.styled, true);
  assert.equal(state.stored, true, 'a row with the shipped wording now holds the styling');
  assert.deepEqual(state.fields, contract.defaultPrintTemplate('excuse', { name: 'Synthetic Roland Dental', address: '1 Example Way, Roland, OK', phone: '(555) 010-0001' }));
  const [row] = db.table('tc_print_templates');
  assert.deepEqual(row.styling, { ...chosen, accentColor: '#1f4e79' });

  const second = await putStyling(baseUrl, { styling: style({ fontPair: 'book' }) });
  assert.equal(second.status, 200);
  const back = await putStyling(baseUrl, { styling: style() });
  assert.equal(back.status, 200);
  assert.equal(back.body.template.styled, false);
  assert.equal(db.table('tc_print_templates')[0].styling, null, 'the standard style is no styling');
  const viaNull = await putStyling(baseUrl, { styling: null });
  assert.equal(viaNull.status, 200);

  assert.deepEqual(
    styleAudits(db).map((a) => [a.action, a.resource_id, a.office, a.prior_state, a.user_id]),
    [
      ['UPDATE', 'roland:excuse', 'roland', 'style_default', 'om@carein.ai'],
      ['UPDATE', 'roland:excuse', 'roland', 'style_set', 'om@carein.ai'],
      ['UPDATE', 'roland:excuse', 'roland', 'style_set', 'om@carein.ai'],
      ['UPDATE', 'roland:excuse', 'roland', 'style_default', 'om@carein.ai'],
    ]
  );
  // A wording save leaves the styling alone.
  await putStyling(baseUrl, { styling: chosen });
  const words = await api(baseUrl, 'PUT', `${SETTINGS}/excuse?office=roland`, { ...state.fields, heading: 'Attendance note' });
  assert.equal(words.status, 200);
  assert.equal(words.body.template.styling.layout, 'centered_formal');
  assert.deepEqual(odCalls, []);
});

// The audit row is written inside the save's transaction (withTenantTx), so on
// real Postgres the styling rolls back with it; the fake DB has no rollback, so
// this pins the half it can see: the save is refused, never reported as saved.
test('an audit write that fails refuses the styling save (fail closed)', async (t) => {
  const db = new FakeTenantDb();
  db.onQuery(/^INSERT INTO audit_log/, () => {
    throw new Error('audit store down');
  });
  const { baseUrl } = await bootSettings(t, { db });
  const r = await putStyling(baseUrl, { styling: style({ layout: 'compact_card' }) });
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 'AUDIT_FAILED');
});

test('old rows (no styling column value) read as the defaults', async (t) => {
  const db = new FakeTenantDb();
  db.table('tc_print_templates').push({
    office_id: 'roland',
    template_type: 'excuse',
    heading: 'H',
    letterhead_name: 'Synthetic Roland Dental',
    letterhead_address: '',
    letterhead_phone: '',
    body: 'B',
    signature_line: '',
    logo_key: null,
    logo_content_type: null,
    updated_by: 'om@carein.ai',
    updated_at: NOW,
  });
  const { baseUrl } = await bootSettings(t, { db });
  const r = await api(baseUrl, 'GET', `${SETTINGS}?office=roland`);
  const excuse = contract.PrintTemplatesResponse.parse(r.body).templates.find((x) => x.type === 'excuse');
  assert.deepEqual(excuse.styling, contract.PRINT_STYLING_DEFAULTS);
  assert.equal(excuse.styled, false);
});

// ── isolation ───────────────────────────────────────────────────────────────

test("office isolation: roland's styling never reaches valley's settings or valley's printout", async (t) => {
  const db = new FakeTenantDb();
  const settings = await bootSettings(t, { db });
  assert.equal((await putStyling(settings.baseUrl, { styling: style({ fontPair: 'modern', accentColor: '#8b0000' }) })).status, 200);
  const valleyState = await api(settings.baseUrl, 'GET', `${SETTINGS}?office=valley`);
  for (const tpl of valleyState.body.templates) assert.deepEqual(tpl.styling, contract.PRINT_STYLING_DEFAULTS);
  await settings.close();

  const roland = seedCard(db);
  const valley = seedCard(db, { office_id: 'valley', od_patient_id: 7115, patient_name: 'TestValley, Stedi' });
  const tc = await bootTc(t, { role: 'tc', db });
  const r = await postRaw(tc.baseUrl, PRINT(roland.handoff_id), { templateType: 'excuse' });
  const v = await postRaw(tc.baseUrl, PRINT(valley.handoff_id, 'valley'), { templateType: 'excuse' });
  assert.equal(r.status, 200);
  assert.equal(v.status, 200);
  assert.match(r.buf.toString('latin1'), /\/BaseFont \/[A-Z]{6}\+Lato-Regular/);
  assert.match(r.buf.toString('latin1'), /0\.545 0\.000 0\.000 rg/);
  const vs = v.buf.toString('latin1');
  assert.ok(!/FontFile2|Lato| rg | RG /.test(vs), 'valley prints the standard style');
  assert.match(vs, /\/BaseFont \/Helvetica /);
  assert.deepEqual(odCalls, []);
});

// ── the PDF: every option, geometry asserted on the PDF itself ──────────────

test('every layout × font pair: the PDF content stream is the layout engine, and the geometry holds in the PDF', async () => {
  const doc = PINNED_DOCS.excuse.doc();
  const logo = prepareLogo(png(9, 3));
  for (const layout of Object.keys(contract.PRINT_LAYOUTS)) {
    for (const fontPair of Object.keys(contract.PRINT_FONT_PAIRS)) {
      const s = style({ layout, fontPair, accentColor: '#1f4e79' });
      const label = `${layout}/${fontPair}`;
      const pdf = renderPrintPdf(doc, { logo, styling: s });
      const engine = contract.layoutPrintDocument(doc, s, { width: logo.width, height: logo.height });
      const [page] = assertPdfIsLayout(pdf, engine, label);
      const widthOf = (op) => contract.textWidth(op.font === 'F2' ? engine.faces.heading : engine.faces.body, op.size, op.text);
      const heading = page.filter((o) => o.kind === 'text' && o.size === (layout === 'compact_card' ? 14 : 16) && o.font === 'F2');
      assert.ok(heading.length > 0, label);
      for (const h of heading) {
        if (layout === 'centered_formal') assert.ok(Math.abs(h.x + widthOf(h) / 2 - W / 2) < 0.02, `${label}: heading centered`);
        else assert.equal(h.x, M, `${label}: heading at the margin`);
      }
      // The accent: letterhead text and its rule only; the body black.
      const coloured = page.filter((o) => o.rgb);
      assert.ok(coloured.length >= 4, label);
      const ruleY = page.find((o) => o.kind === 'rule').y;
      for (const o of coloured) assert.ok(o.kind === 'rule' ? o.y === ruleY : o.y > ruleY, `${label}: only above the rule is coloured`);
      for (const o of page.filter((x) => x.kind === 'text' && x.y < ruleY)) assert.equal(o.rgb, null, `${label}: "${o.text}" is black`);
      assert.equal(page.some((o) => o.kind === 'frame'), layout === 'compact_card', `${label}: frame`);
      // The fonts: base-14 for the standard pair, embedded TrueType otherwise.
      const raw = pdf.toString('latin1');
      if (fontPair === 'standard') {
        assert.ok(!raw.includes('FontFile2'), label);
      } else {
        const faces = contract.PRINT_FONT_PAIRS[fontPair];
        for (const face of [faces.heading, faces.body]) {
          assert.match(raw, new RegExp(`/BaseFont /[A-Z]{6}\\+${contract.PRINT_FONT_FACES[face].postscriptName} `), `${label}: ${face}`);
        }
        assert.equal((raw.match(/\/FontFile2 /g) || []).length, 2, label);
        assert.ok(pdf.length < 120 * 1024, `${label}: subset keeps the printout small (${pdf.length} bytes)`);
      }
      const text = await pdfText(pdf);
      for (const expected of ['Synthetic Roland Dental', 'School / Work Excuse', 'Dr. Sample Provider, Synthetic Roland Dental']) {
        assert.ok(text.includes(expected), `${label}: PDF lacks "${expected}": ${text}`);
      }
    }
  }
});

test('every logo placement × size, in every layout: where the PDF draws the logo', () => {
  const doc = PINNED_DOCS.appointment_card.doc();
  const logo = prepareLogo(png(4, 9));
  for (const layout of Object.keys(contract.PRINT_LAYOUTS)) {
    for (const logoPlacement of Object.keys(contract.PRINT_LOGO_PLACEMENTS)) {
      for (const logoSize of Object.keys(contract.PRINT_LOGO_SIZES)) {
        const s = style({ layout, logoPlacement, logoSize });
        const label = `${layout}/${logoPlacement}/${logoSize}`;
        const pdf = renderPrintPdf(doc, { logo, styling: s });
        const [page] = assertPdfIsLayout(pdf, contract.layoutPrintDocument(doc, s, { width: logo.width, height: logo.height }), label);
        const img = page.find((o) => o.kind === 'image');
        const box = contract.PRINT_LOGO_SIZES[logoSize].box;
        assert.ok(Math.abs(Math.max(img.w, img.h) - box) < 0.01, `${label}: box`);
        assert.ok(Math.abs(img.y + img.h - (H - M)) < 0.02, `${label}: top`);
        const centre = img.x + img.w / 2;
        if (logoPlacement === 'left') assert.equal(img.x, M, label);
        if (logoPlacement === 'right') assert.ok(Math.abs(img.x + img.w - (W - M)) < 0.02, label);
        if (logoPlacement === 'center') assert.ok(Math.abs(centre - W / 2) < 0.02, label);
        // No logo uploaded: the section is simply absent, wherever it was placed.
        const without = renderPrintPdf(doc, { logo: null, styling: s });
        assert.ok(!without.toString('latin1').includes('/Im1'), `${label}: no logo`);
      }
    }
  }
});

// ── defaults: byte-stable ───────────────────────────────────────────────────

test('an untouched template (NULL styling) prints the pinned CO-3 bytes through the print route', async (t) => {
  const db = new FakeTenantDb();
  const card = seedCard(db);
  db.table('tc_print_templates').push({
    office_id: 'roland',
    template_type: 'excuse',
    heading: 'School / Work Excuse',
    letterhead_name: 'Synthetic Roland Dental',
    letterhead_address: '1 Example Way\nRoland, OK 74954',
    letterhead_phone: '(555) 010-0001',
    body: 'Seen on {{date_seen}}.',
    signature_line: '{{provider_name}}',
    logo_key: null,
    logo_content_type: null,
    styling: null,
    updated_by: 'om@carein.ai',
    updated_at: NOW,
  });
  const { baseUrl } = await bootTc(t, { role: 'tc', db });
  const r = await postRaw(baseUrl, PRINT(card.handoff_id), { templateType: 'excuse' });
  assert.equal(r.status, 200);
  // The same document through CO-3's arithmetic, which the pins hold.
  const doc = contract.composePrintDocument(
    { heading: 'School / Work Excuse', letterheadName: 'Synthetic Roland Dental', letterheadAddress: '1 Example Way\nRoland, OK 74954', letterheadPhone: '(555) 010-0001', body: 'Seen on {{date_seen}}.', signatureLine: '{{provider_name}}' },
    { patient_first_name: '', patient_full_name: '', date_seen: 'October 30, 2026', time_seen_range: '', next_appointment_date: '', next_appointment_time: '', office_name: '', office_address: '', office_phone: '', provider_name: 'DOC1' }
  );
  assert.ok(r.buf.equals(renderPrintPdf(doc, {})), 'the route prints exactly the unstyled renderer');
  for (const [name, entry] of Object.entries(PINNED_DOCS)) {
    const pdf = renderPrintPdf(entry.doc(), { logo: entry.logo ? prepareLogo(entry.logo()) : null, styling: null });
    assert.equal(crypto.createHash('sha256').update(pdf).digest('hex'), PINNED_SHA256[name], name);
  }
});

// ── the preview's fonts ─────────────────────────────────────────────────────

test('the font route serves the allow-listed bundled files, byte for byte, and nothing else', async (t) => {
  const { baseUrl } = await bootSettings(t);
  for (const file of contract.PRINT_FONT_FILES) {
    const res = await fetch(`${baseUrl}${SETTINGS}/fonts/${file}?office=roland`);
    assert.equal(res.status, 200, file);
    assert.equal(res.headers.get('content-type'), 'font/ttf', file);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(fs.readFileSync(path.join(FONT_DIR, file))), file);
  }
  for (const bad of ['OFL-Lato.txt', 'nope.ttf', '..%2F..%2Fpackage.json', '..%5C..%5Cpackage.json', 'Lato-Regular.TTF']) {
    const res = await fetch(`${baseUrl}${SETTINGS}/fonts/${bad}?office=roland`);
    assert.equal(res.status, 404, bad);
  }
});

// ── review round 1 ──────────────────────────────────────────────────────────

/** A minimal baseline JPEG header: SOI, an optional EXIF APP1 with an orientation, SOF0 (4×2, RGB), EOI. */
function jpeg(orientation) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (orientation !== undefined) {
    // TIFF, big-endian: header, IFD0 at 8 with one entry (0x0112 SHORT 1 = orientation).
    const tiff = Buffer.alloc(8 + 2 + 12 + 4);
    tiff.write('MM', 0, 'latin1');
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(orientation, 18);
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(body.length + 2);
    parts.push(Buffer.from([0xff, 0xe1]), len, body);
  }
  parts.push(Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x04, 0x03, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]));
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

test('REVIEW: a JPEG stored sideways with an EXIF rotation is refused at upload, by name — the preview and the PDF would disagree about its shape', async (t) => {
  const { prepareLogo, jpegOrientation, LogoImageError } = require('../services/tc/printImage');
  assert.equal(jpegOrientation(jpeg()), 1);
  assert.equal(jpegOrientation(jpeg(1)), 1);
  assert.equal(jpegOrientation(jpeg(6)), 6);
  assert.equal(prepareLogo(jpeg(1)).width, 4, 'an upright JPEG is fine');
  assert.throws(() => prepareLogo(jpeg(6)), (e) => e instanceof LogoImageError && e.code === 'LOGO_JPEG_ROTATED');

  process.env.TC_BLOB_ACCOUNT_URL = 'https://example.invalid';
  const blobs = new Map();
  assets.setContainerClientForTests({ getBlockBlobClient: (key) => ({ uploadData: async (d) => blobs.set(key, d) }) });
  const { baseUrl, db } = await bootSettings(t);
  const form = new FormData();
  form.append('file', new Blob([jpeg(8)]), 'phone.jpg');
  const res = await fetch(`${baseUrl}${SETTINGS}/excuse/logo?office=roland`, { method: 'POST', body: form });
  const body = await res.json();
  assert.equal(res.status, 415);
  assert.equal(body.code, 'LOGO_JPEG_ROTATED');
  assert.match(body.error, /stored sideways/);
  assert.equal(blobs.size, 0, 'nothing stored');
  assert.equal(db.table('tc_print_templates').length, 0);
});

test('REVIEW: two FIRST saves racing — a styling save that loses applies as an update, not a 500', async () => {
  const store = require('../services/tc/printTemplateStore');
  const db = new FakeTenantDb();
  // Another first save's row is already there, but this save's lock read ran first and saw none.
  db.table('tc_print_templates').push({ office_id: 'roland', template_type: 'excuse', heading: 'theirs', styling: null, updated_by: 'other@carein.ai' });
  db.onQuery(/FROM tc_print_templates WHERE office_id = \$1 AND template_type = \$2 FOR UPDATE$/, () => ({ rows: [] }));
  const chosen = style({ layout: 'compact_card' });
  const out = await store.saveStyling(db, { office: 'roland', type: 'excuse', styling: chosen, actor: 'om@carein.ai', prefill: { name: 'x', address: '', phone: '' } });
  assert.equal(out.prior, 'style_default');
  assert.equal(db.table('tc_print_templates').length, 1, 'one row, never a second');
  const [row] = db.table('tc_print_templates');
  assert.deepEqual(row.styling, chosen);
  // The SQL updates only `styling, updated_by, updated_at` on conflict, so on
  // Postgres the other save keeps its wording. FakeTenantDb's upsert copies every
  // inserted column regardless of the SET list, so that half is pinned on the
  // statement instead.
  const upsert = db.log.find((l) => /^INSERT INTO tc_print_templates/.test(l.sql));
  assert.match(upsert.sql, /ON CONFLICT \(office_id, template_type\) DO UPDATE SET styling = EXCLUDED\.styling, updated_by = EXCLUDED\.updated_by, updated_at = now\(\)$/);
});

test('REVIEW: going back to the defaults with nothing saved writes nothing and audits nothing', async (t) => {
  const { baseUrl, db } = await bootSettings(t);
  for (const styling of [null, style()]) {
    const r = await putStyling(baseUrl, { styling });
    assert.equal(r.status, 200);
    assert.equal(r.body.template.stored, false, 'still the shipped default');
    assert.deepEqual(r.body.template.styling, contract.PRINT_STYLING_DEFAULTS);
  }
  assert.equal(db.table('tc_print_templates').length, 0);
  assert.equal(styleAudits(db).length, 0);
});
