'use strict';

/**
 * OB-1 — GET /api/admin/setup-status, the /admin hub's "Practice setup" card.
 *
 *   gate        admin.all (office, tc, hygiene, doctor refused 403); bad office 400
 *   steps       each step's done AND needs-attention case, on fixtures
 *   hyg         P3 and P8 are absent when the practice is not entitled to hyg
 *   P5          required only while an email feature is on for the office
 *   isolation   valley's rows are never counted for roland (every query names
 *               the requested office)
 *   privacy     the response never contains '@', an app-setting name, or a
 *               setting key — even when the stored identity holds an address
 *   read-only   every statement is a SELECT; no Open Dental module is reached
 *   honesty     a reader that throws reads "could not check", never done
 *   wiring      server.js mounts it behind admin.all, no module guard, ABOVE
 *               the voice-guarded /api/admin
 *
 * Staff and config only — no patient data anywhere in these fixtures. Names
 * are synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { before, after, beforeEach } = test;
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const registry = require('../platform/registry');
const tenantDb = require('../platform/tenantDb');
const userContext = require('../platform/userContext');
const { tenantContext } = require('../middleware/tenantContext');
const { requirePermission } = require('../config/permissions');
const emailIdentity = require('../config/emailIdentity');
const tcEmail = require('../config/tcEmail');
const tcCheckout = require('../config/tcCheckout');
const tcReferrals = require('../config/tcReferrals');
const tcReferralEmail = require('../config/tcReferralEmail');
const { COULD_NOT_CHECK } = require('../services/setupStatus');

const URL_PATH = '/api/admin/setup-status';

// ── environment ─────────────────────────────────────────────────────────────

const ENV_KEYS = [
  'TC_EMAIL_PRACTICE_NAME_ROLAND',
  'TC_EMAIL_PRACTICE_PHONE_ROLAND',
  'TC_EMAIL_PRACTICE_ADDRESS_ROLAND',
  'TC_EMAIL_PRACTICE_NAME_VALLEY',
  'TC_EMAIL_PRACTICE_PHONE_VALLEY',
  'TC_EMAIL_PRACTICE_ADDRESS_VALLEY',
  'ACS_EMAIL_REPLY_TO_ROLAND',
  'ACS_EMAIL_REPLY_TO_VALLEY',
  'TC_EMAIL_ENABLED',
  'TC_REFERRAL_EMAIL_ENABLED_ROLAND',
  'TC_REFERRAL_EMAIL_ENABLED_VALLEY',
  'TC_CHECKOUT_ENABLED_ROLAND',
  'TC_CHECKOUT_ENABLED_VALLEY',
  'TC_REFERRALS_ENABLED_ROLAND',
  'TC_REFERRALS_ENABLED_VALLEY',
  'TC_BLOB_ACCOUNT_URL',
];
const savedEnv = {};
const REGISTRY_KEYS = [
  'getUserByEmail',
  'getTenantById',
  'getTenantClinics',
  'getEnabledModules',
  'getPlatformAdminByEmail',
  'touchUserLogin',
  'listTenantUsers',
  'getPlatformSetting',
];
const savedRegistry = {};
let savedWithTenantDb;

/** What platform_setting answers, by key (per test). */
let platformSettings = {};
/** The practice's users (per test). */
let tenantUsersRows = [];
/** The tenant id listTenantUsers was asked for. */
let usersAskedFor = [];

function resetSwitchCaches() {
  emailIdentity.resetCacheForTests();
  tcEmail.resetCacheForTests();
  tcCheckout.resetCacheForTests();
  tcReferrals.resetCacheForTests();
  tcReferralEmail.resetCacheForTests();
}

before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of REGISTRY_KEYS) savedRegistry[k] = registry[k];
  savedWithTenantDb = tenantDb.withTenantDb;
});
after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const [k, v] of Object.entries(savedRegistry)) registry[k] = v;
  tenantDb.withTenantDb = savedWithTenantDb;
  resetSwitchCaches();
  userContext.clearCache();
});
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  platformSettings = {};
  tenantUsersRows = [];
  usersAskedFor = [];
  registry.getPlatformSetting = async (key) => (key in platformSettings ? { value: platformSettings[key], updated_at: null, updated_by: null } : null);
  registry.listTenantUsers = async (tenantId) => {
    usersAskedFor.push(tenantId);
    return tenantUsersRows;
  };
  resetSwitchCaches();
});

// ── a fake tenant pool that records every statement ─────────────────────────

/** Which column carries the office, per table. */
const OFFICE_COL = {
  hyg_staff: 'office',
  tc_provider_directory: 'office_id',
  tc_referral_directory: 'office_id',
  tc_print_templates: 'office_id',
  tc_referral_templates: 'office_id',
};

class FakePool {
  constructor() {
    /** @type {Record<string, Array<Record<string, unknown>>>} */
    this.tables = Object.fromEntries(Object.keys(OFFICE_COL).map((t) => [t, []]));
    /** @type {Array<{ sql: string, params: unknown[], table: string|null }>} */
    this.log = [];
    /** @type {Set<string>} tables whose read throws */
    this.broken = new Set();
  }

  async query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    const m = text.match(/\bFROM (\w+)/i);
    const table = m ? m[1] : null;
    this.log.push({ sql: text, params, table });
    if (!/^SELECT /i.test(text)) throw new Error(`setup status must only read; got: ${text.slice(0, 40)}`);
    if (!table || !(table in OFFICE_COL)) throw new Error(`unexpected table: ${table}`);
    if (this.broken.has(table)) throw new Error(`${table} is unreadable in this test`);
    const col = OFFICE_COL[table];
    // The SQL itself must scope by office; the fake then answers as Postgres would.
    assert.match(text, new RegExp(`WHERE ${col} = \\$1`), `${table} read is not office-scoped: ${text}`);
    let rows = this.tables[table].filter((r) => r[col] === params[0]);
    if (/ AND active = \$2/.test(text)) rows = rows.filter((r) => r.active === params[1]);
    return { rows };
  }
}

// ── fixtures (staff and config only; synthetic names) ───────────────────────

function hygienist(office, i, { license = 'RDH-0000', signIn = true, active = true } = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    office,
    full_name: `Synthetic Hygienist ${i}`,
    license,
    sign_in_ids: signIn ? [`hyg${i}.example`] : [],
    active,
    created_by: 'fixture',
    created_at: new Date('2026-11-01T00:00:00Z'),
    updated_by: 'fixture',
    updated_at: new Date('2026-11-01T00:00:00Z'),
  };
}

function provider(office, i, active = true) {
  return { provider_id: `p-${office}-${i}`, office_id: office, name: `Dr. Synthetic ${i}`, credential_suffix: 'DDS', active, od_prov_num: null };
}

function specialist(office, i, active = true) {
  return { entry_id: `s-${office}-${i}`, office_id: office, practice_name: `Synthetic Oral Surgery ${i}`, active };
}

function printRow(office, type, { logo = false } = {}) {
  return {
    office_id: office,
    template_type: type,
    heading: 'Heading',
    letterhead_name: 'Synthetic Dental',
    letterhead_address: '1 Example Way',
    letterhead_phone: '(555) 010-0000',
    body: 'Body',
    signature_line: 'Sig',
    logo_key: logo ? `${office}/${type}.png` : null,
    logo_content_type: logo ? 'image/png' : null,
    styling: null,
    updated_by: 'fixture',
    updated_at: new Date('2026-11-01T00:00:00Z'),
  };
}

function refTemplate(office, kind, body = 'Saved wording') {
  return { office_id: office, template_kind: kind, body, updated_by: 'fixture', updated_at: new Date(), created_at: new Date() };
}

/** Everything a fully set-up office has. */
function seedComplete(pool, office) {
  pool.tables.hyg_staff.push(hygienist(office, 1), hygienist(office, 2));
  pool.tables.tc_provider_directory.push(provider(office, 1));
  pool.tables.tc_referral_directory.push(specialist(office, 1));
  pool.tables.tc_print_templates.push(printRow(office, 'excuse', { logo: true }), printRow(office, 'appointment_card', { logo: true }));
  pool.tables.tc_referral_templates.push(refTemplate(office, 'specialist_message'), refTemplate(office, 'correspondence_note'));
}

function setOfficeEnv(office) {
  const O = office.toUpperCase();
  process.env[`TC_EMAIL_PRACTICE_NAME_${O}`] = `Synthetic ${office} Dental`;
  process.env[`TC_EMAIL_PRACTICE_PHONE_${O}`] = '(555) 010-0001';
  process.env[`TC_EMAIL_PRACTICE_ADDRESS_${O}`] = '1 Example Way';
}

function user(email, role, status = 'active') {
  return { user_id: email, tenant_id: 'T1', email, role, status, last_login_at: null, home_office: null };
}

// ── boot ─────────────────────────────────────────────────────────────────────

/** Mounted exactly as server.js mounts it, with the real tenant + permission gates. */
async function boot(t, { role = 'admin', modules = ['tc', 'hyg'], pool = new FakePool(), dbThrows = false } = {}) {
  registry.getUserByEmail = async () => ({ user_id: 'U1', tenant_id: 'T1', email: 'om@carein.ai', role, status: 'active' });
  registry.getTenantById = async () => ({ tenant_id: 'T1', slug: 'carein', display_name: 'CareIN', status: 'active' });
  registry.getTenantClinics = async () => [];
  registry.getEnabledModules = async () => modules;
  registry.getPlatformAdminByEmail = async () => null;
  registry.touchUserLogin = async () => {};
  userContext.clearCache();
  tenantDb.withTenantDb = async (_req, fn) => {
    if (dbThrows) throw new Error('tenant database unreachable in this test');
    return fn(pool);
  };
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = { email: 'om@carein.ai', name: 'Office Manager', tenantId: 'T1' };
    next();
  });
  app.use('/api', tenantContext());
  app.use('/api/admin/setup-status', requirePermission('admin.all'), require('./setupStatus'));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => new Promise((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    pool,
    async get(office) {
      const q = office === undefined ? '' : `?office=${encodeURIComponent(office)}`;
      const res = await fetch(`${base}${URL_PATH}${q}`);
      const text = await res.text();
      return { status: res.status, text, body: JSON.parse(text) };
    },
  };
}

function stepOf(body, id) {
  return body.steps.find((s) => s.id === id);
}

// ── gate ─────────────────────────────────────────────────────────────────────

test('non-admin roles are refused 403 before any reader runs', async (t) => {
  for (const role of ['office', 'tc', 'hygiene', 'doctor', 'reviewer', 'rcm_biller']) {
    const app = await boot(t, { role });
    const res = await app.get('roland');
    assert.equal(res.status, 403, role);
    assert.equal(app.pool.log.length, 0, `${role}: no statement may run for a refused caller`);
    assert.equal(usersAskedFor.length, 0);
  }
});

test('the office must be a real office key: missing or unknown → 400 INVALID_OFFICE', async (t) => {
  const app = await boot(t);
  for (const office of [undefined, '', 'unknown', 'nowhere']) {
    const res = await app.get(office);
    assert.equal(res.status, 400, String(office));
    assert.equal(res.body.code, 'INVALID_OFFICE');
  }
});

test('a TC-only practice (no voice) still gets the card: no module guard', async (t) => {
  const app = await boot(t, { modules: ['tc'] });
  const res = await app.get('roland');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.office, 'roland');
});

// ── a fully set-up office ───────────────────────────────────────────────────

test('a fully set-up office: every required step done, counts add up', async (t) => {
  const pool = new FakePool();
  seedComplete(pool, 'roland');
  setOfficeEnv('roland');
  process.env.TC_BLOB_ACCOUNT_URL = 'https://example.invalid';
  platformSettings.tc_email_identity = {
    roland: { replyTo: 'front.desk@synthetic-roland.example', practiceName: 'Synthetic Roland Dental', practicePhone: '(555) 010-0001' },
  };
  tenantUsersRows = [user('a@x.example', 'admin'), user('t@x.example', 'tc'), user('d@x.example', 'doctor')];
  const app = await boot(t, { pool });
  const res = await app.get('roland');
  assert.equal(res.status, 200);
  const ids = res.body.steps.map((s) => s.id);
  assert.deepEqual(ids, ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9']);
  for (const s of res.body.steps) {
    assert.equal(typeof s.title, 'string');
    assert.equal(typeof s.detail, 'string');
    assert.ok(s.link.startsWith('/'), `${s.id} links to a screen`);
    assert.ok(s.status === 'done' || s.status === 'needs_attention');
    if (s.id !== 'P8') assert.equal(s.status, 'done', `${s.id}: ${s.detail}`);
  }
  // P8 is the shipped drafts — not something the office can fix, so it is the
  // one required step still open here.
  assert.equal(stepOf(res.body, 'P8').status, 'needs_attention');
  const required = res.body.steps.filter((s) => s.required);
  assert.equal(res.body.totalRequired, required.length);
  assert.equal(res.body.doneRequired, required.filter((s) => s.status === 'done').length);
  assert.equal(res.body.doneRequired, res.body.totalRequired - 1);
  // The practice is the session's tenant.
  assert.deepEqual(usersAskedFor, ['T1']);
});

// ── each step, needs-attention ──────────────────────────────────────────────

test('P1 office details: done when name, address and phone prefill; names what is missing otherwise', async (t) => {
  setOfficeEnv('roland');
  let app = await boot(t);
  let s = stepOf((await app.get('roland')).body, 'P1');
  assert.equal(s.status, 'done');
  assert.equal(s.required, true);

  delete process.env.TC_EMAIL_PRACTICE_ADDRESS_ROLAND;
  delete process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND;
  app = await boot(t);
  s = stepOf((await app.get('roland')).body, 'P1');
  assert.equal(s.status, 'needs_attention');
  assert.match(s.detail, /address and phone/);
});

test('P2 team & roles: needs an admin AND someone who can do TC work; doctor optional; counts only', async (t) => {
  tenantUsersRows = [user('a@x.example', 'admin'), user('h@x.example', 'hygiene'), user('old@x.example', 'tc', 'disabled')];
  let app = await boot(t);
  let s = stepOf((await app.get('roland')).body, 'P2');
  // admin holds tc.full, so the TC requirement is met by the admin.
  assert.equal(s.status, 'done');
  assert.match(s.detail, /1 admin, 1 hygiene/);
  assert.match(s.detail, /\(optional\) a doctor/);
  assert.doesNotMatch(s.detail, /TC\b(?! work)/, 'the disabled TC user is not counted');

  tenantUsersRows = [user('h@x.example', 'hygiene'), user('d@x.example', 'doctor')];
  app = await boot(t);
  s = stepOf((await app.get('roland')).body, 'P2');
  assert.equal(s.status, 'needs_attention');
  assert.match(s.detail, /an admin and someone who can do TC work/);

  tenantUsersRows = [];
  app = await boot(t);
  s = stepOf((await app.get('roland')).body, 'P2');
  assert.equal(s.status, 'needs_attention');
  assert.match(s.detail, /No active users/);
});

test('P3 hygienist roster: needs ≥1 active hygienist, each with a licence and a signature', async (t) => {
  const pool = new FakePool();
  let app = await boot(t, { pool });
  let s = stepOf((await app.get('roland')).body, 'P3');
  assert.equal(s.status, 'needs_attention');
  assert.equal(s.required, true);
  assert.match(s.detail, /No active hygienists/);

  pool.tables.hyg_staff.push(
    hygienist('roland', 1),
    hygienist('roland', 2, { signIn: false }),
    hygienist('roland', 3, { license: null }),
    hygienist('roland', 4, { active: false, signIn: false })
  );
  app = await boot(t, { pool });
  s = stepOf((await app.get('roland')).body, 'P3');
  assert.equal(s.status, 'needs_attention');
  assert.equal(s.detail, '3 active hygienists: 2 of 3 have a name and licence, 2 of 3 have a signature.');

  pool.tables.hyg_staff = [hygienist('roland', 1), hygienist('roland', 2)];
  app = await boot(t, { pool });
  s = stepOf((await app.get('roland')).body, 'P3');
  assert.equal(s.status, 'done');
});

test('P4 directories: optional; done with ≥1 active provider and ≥1 active specialist', async (t) => {
  const pool = new FakePool();
  pool.tables.tc_provider_directory.push(provider('roland', 1), provider('roland', 2, false));
  let app = await boot(t, { pool });
  let s = stepOf((await app.get('roland')).body, 'P4');
  assert.equal(s.required, false);
  assert.equal(s.status, 'needs_attention');
  assert.equal(s.detail, "1 active provider and 0 active specialists in this office's directory.");

  pool.tables.tc_referral_directory.push(specialist('roland', 1));
  app = await boot(t, { pool });
  s = stepOf((await app.get('roland')).body, 'P4');
  assert.equal(s.status, 'done');
});

test('P5 email identity: required ONLY while an email feature is on; stored vs fallback by field name', async (t) => {
  // Nothing on → optional.
  let app = await boot(t);
  let s = stepOf((await app.get('roland')).body, 'P5');
  assert.equal(s.required, false);
  assert.equal(s.status, 'needs_attention');
  assert.match(s.detail, /Not set: reply-to, practice name and phone/);

  // Referral email on for roland → required for roland, still optional for valley.
  process.env.TC_REFERRAL_EMAIL_ENABLED_ROLAND = 'true';
  resetSwitchCaches();
  app = await boot(t);
  assert.equal(stepOf((await app.get('roland')).body, 'P5').required, true);
  resetSwitchCaches();
  assert.equal(stepOf((await app.get('valley')).body, 'P5').required, false);
  delete process.env.TC_REFERRAL_EMAIL_ENABLED_ROLAND;

  // TC email (practice-wide) on → required for every office.
  process.env.TC_EMAIL_ENABLED = 'true';
  resetSwitchCaches();
  app = await boot(t);
  assert.equal(stepOf((await app.get('valley')).body, 'P5').required, true);

  // Two stored, one only in the app settings → needs attention, named by field.
  platformSettings.tc_email_identity = {
    roland: { replyTo: 'front.desk@synthetic-roland.example', practiceName: 'Synthetic Roland Dental' },
  };
  process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND = '(555) 010-0001';
  resetSwitchCaches();
  app = await boot(t);
  let res = await app.get('roland');
  s = stepOf(res.body, 'P5');
  assert.equal(s.status, 'needs_attention');
  assert.equal(s.detail, 'Saved for this office: reply-to and practice name. Only using the app settings: phone.');
  assert.ok(!res.text.includes('@'), 'the stored reply-to address never leaves the server');

  // All three stored → done.
  platformSettings.tc_email_identity.roland.practicePhone = '(555) 010-0001';
  resetSwitchCaches();
  app = await boot(t);
  res = await app.get('roland');
  assert.equal(stepOf(res.body, 'P5').status, 'done');
  assert.ok(!res.text.includes('@'));
});

test('P6 print templates: wording saved per kind, and a logo per kind once logo storage exists', async (t) => {
  const pool = new FakePool();
  pool.tables.tc_print_templates.push(printRow('roland', 'excuse'));
  let app = await boot(t, { pool });
  let s = stepOf((await app.get('roland')).body, 'P6');
  assert.equal(s.required, true);
  assert.equal(s.status, 'needs_attention');
  assert.match(s.detail, /School \/ work excuse: wording saved/);
  assert.match(s.detail, /Appointment card: default wording/);
  assert.match(s.detail, /Logo upload is not set up in this environment/);

  // Both saved, storage absent → done (a logo cannot be uploaded, so it is not counted).
  pool.tables.tc_print_templates.push(printRow('roland', 'appointment_card'));
  app = await boot(t, { pool });
  assert.equal(stepOf((await app.get('roland')).body, 'P6').status, 'done');

  // Storage present, no logos → needs attention; logos → done.
  process.env.TC_BLOB_ACCOUNT_URL = 'https://example.invalid';
  app = await boot(t, { pool });
  s = stepOf((await app.get('roland')).body, 'P6');
  assert.equal(s.status, 'needs_attention');
  assert.match(s.detail, /no logo/);
  pool.tables.tc_print_templates = [printRow('roland', 'excuse', { logo: true }), printRow('roland', 'appointment_card', { logo: true })];
  app = await boot(t, { pool });
  assert.equal(stepOf((await app.get('roland')).body, 'P6').status, 'done');
});

test('P7 referral templates: optional; done when both kinds are saved', async (t) => {
  const pool = new FakePool();
  pool.tables.tc_referral_templates.push(refTemplate('roland', 'specialist_message'), refTemplate('roland', 'correspondence_note', '   '));
  let app = await boot(t, { pool });
  let s = stepOf((await app.get('roland')).body, 'P7');
  assert.equal(s.required, false);
  assert.equal(s.status, 'needs_attention');
  assert.equal(s.detail, 'Message to the specialist: saved. Correspondence note: not saved.');

  pool.tables.tc_referral_templates = [refTemplate('roland', 'specialist_message'), refTemplate('roland', 'correspondence_note')];
  app = await boot(t, { pool });
  assert.equal(stepOf((await app.get('roland')).body, 'P7').status, 'done');
});

test('P8 hygiene note templates: counts the picker\'s live "(draft)" types from the shared contract', async (t) => {
  const hygContract = require('../hyg/contract.gen.cjs');
  const live = hygContract.VISIT_TYPES.filter((v) => !hygContract.RETIRED_VISIT_TYPES.has(v));
  const drafts = live.filter((v) => hygContract.DRAFT_VISIT_TYPES.has(v)).length;
  const app = await boot(t);
  const s = stepOf((await app.get('roland')).body, 'P8');
  assert.equal(s.required, true);
  assert.ok(drafts > 0, 'today the contract still ships drafts');
  assert.equal(s.status, 'needs_attention');
  assert.equal(s.detail, `${drafts} of ${live.length} visit types are still marked "(draft)", awaiting the practice hygienist's approval.`);

  // The done case: with no drafts the step is done. Swap the shared Set's
  // contents for the duration of the call, then put them back exactly.
  const saved = [...hygContract.DRAFT_VISIT_TYPES];
  hygContract.DRAFT_VISIT_TYPES.clear();
  try {
    const app2 = await boot(t);
    const done = stepOf((await app2.get('roland')).body, 'P8');
    assert.equal(done.status, 'done');
    assert.equal(done.detail, 'Every visit type uses approved note wording.');
  } finally {
    for (const v of saved) hygContract.DRAFT_VISIT_TYPES.add(v);
  }
  assert.equal(hygContract.DRAFT_VISIT_TYPES.size, saved.length);
});

test('P9 features: informational, reads the checkout and referrals switches for the office', async (t) => {
  process.env.TC_CHECKOUT_ENABLED_ROLAND = 'true';
  platformSettings.tc_referrals_enabled = { valley: true };
  const app = await boot(t);
  const roland = stepOf((await app.get('roland')).body, 'P9');
  assert.equal(roland.required, false);
  assert.equal(roland.status, 'done');
  assert.equal(roland.detail, 'Checkout is on and Referrals is off for this office. CareIN support sets these.');
  resetSwitchCaches();
  const valley = stepOf((await app.get('valley')).body, 'P9');
  assert.equal(valley.detail, 'Checkout is off and Referrals is on for this office. CareIN support sets these.');
});

// ── hyg entitlement ─────────────────────────────────────────────────────────

test('P3 and P8 are left out entirely when the practice is not entitled to hyg', async (t) => {
  const pool = new FakePool();
  const app = await boot(t, { modules: ['tc'], pool });
  const res = await app.get('roland');
  const ids = res.body.steps.map((s) => s.id);
  assert.deepEqual(ids, ['P1', 'P2', 'P4', 'P5', 'P6', 'P7', 'P9']);
  assert.ok(!pool.log.some((q) => q.table === 'hyg_staff'), 'the hygienist roster is not even read');
  assert.equal(res.body.totalRequired, res.body.steps.filter((s) => s.required).length);
});

// ── isolation ───────────────────────────────────────────────────────────────

test('cross-office isolation: a fully set-up valley is never counted for roland', async (t) => {
  const pool = new FakePool();
  seedComplete(pool, 'valley');
  setOfficeEnv('valley');
  const app = await boot(t, { pool });

  const roland = (await app.get('roland')).body;
  assert.equal(stepOf(roland, 'P1').status, 'needs_attention');
  assert.match(stepOf(roland, 'P3').detail, /No active hygienists/);
  assert.equal(stepOf(roland, 'P4').detail, "0 active providers and 0 active specialists in this office's directory.");
  assert.match(stepOf(roland, 'P6').detail, /School \/ work excuse: default wording/);
  assert.equal(stepOf(roland, 'P7').status, 'needs_attention');
  // Every statement the roland request ran named roland, and only roland.
  assert.ok(pool.log.length > 0);
  for (const q of pool.log) assert.equal(q.params[0], 'roland', q.sql);

  pool.log = [];
  const valley = (await app.get('valley')).body;
  for (const id of ['P1', 'P3', 'P4', 'P6', 'P7']) assert.equal(stepOf(valley, id).status, 'done', id);
  for (const q of pool.log) assert.equal(q.params[0], 'valley', q.sql);
});

// ── privacy ─────────────────────────────────────────────────────────────────

test('the response carries no email address, app-setting name or setting key', async (t) => {
  const pool = new FakePool();
  seedComplete(pool, 'roland');
  setOfficeEnv('roland');
  process.env.ACS_EMAIL_REPLY_TO_ROLAND = 'env.reply@synthetic-roland.example';
  process.env.TC_EMAIL_ENABLED = 'true';
  platformSettings.tc_email_identity = { roland: { replyTo: 'front.desk@synthetic-roland.example' } };
  tenantUsersRows = [user('admin.person@synthetic.example', 'admin'), user('tc.person@synthetic.example', 'tc')];
  const app = await boot(t, { pool });
  for (const office of ['roland', 'valley']) {
    resetSwitchCaches();
    const res = await app.get(office);
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('@'), `${office}: no '@' anywhere in the response`);
    // Env-var-shaped names (ACS_EMAIL_REPLY_TO_ROLAND, TC_EMAIL_ENABLED, ...).
    assert.doesNotMatch(res.text, /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/, `${office}: no app-setting name`);
    // platform_setting keys and Key Vault-style secret names.
    assert.doesNotMatch(res.text, /tc_\w+_enabled|tc_email_identity|customer-key|developer-key|secret|password/i);
    // None of the fixtures' contact values either.
    assert.ok(!res.text.includes('Synthetic Hygienist'), 'hygienist names are counted, not listed');
    assert.ok(!res.text.includes('Dr. Synthetic'), 'provider names are counted, not listed');
  }
});

// ── read-only, and honest failure ───────────────────────────────────────────

test('read-only: every statement is a SELECT, and only GET is answered', async (t) => {
  const pool = new FakePool();
  seedComplete(pool, 'roland');
  const app = await boot(t, { pool });
  await app.get('roland');
  assert.ok(pool.log.length > 0);
  for (const q of pool.log) assert.match(q.sql, /^SELECT /i);
  const router = require('./setupStatus');
  const methods = router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods));
  assert.deepEqual(methods, ['get']);
});

test('no Open Dental, no write path: the service and route reach no OD or writing module', () => {
  for (const file of ['../services/setupStatus.js', './setupStatus.js']) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.doesNotMatch(src, /require\([^)]*(odOffices|openDental|odAccess|odPatientCache|odConfigCache)[^)]*\)/, file);
    assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM|\w+\s+SET)\b/, file);
    assert.doesNotMatch(src, /\.(persist|saveFields|setLogo|saveStyling|saveTemplate|create|update|setActive)\(/, file);
    assert.doesNotMatch(src, /SELECT \*/i, file);
  }
});

test('a reader that throws reads "could not check" — never done — and the rest still answer', async (t) => {
  const pool = new FakePool();
  seedComplete(pool, 'roland');
  pool.broken.add('tc_referral_templates');
  pool.broken.add('hyg_staff');
  registry.listTenantUsers = async () => {
    throw new Error('control plane unreachable in this test');
  };
  const app = await boot(t, { pool });
  const res = await app.get('roland');
  assert.equal(res.status, 200);
  for (const id of ['P2', 'P3', 'P7']) {
    const s = stepOf(res.body, id);
    assert.equal(s.status, 'needs_attention', id);
    assert.equal(s.detail, COULD_NOT_CHECK, id);
  }
  assert.equal(stepOf(res.body, 'P4').status, 'done', 'an unrelated step still answers');
});

test('the tenant database unreachable → 503, never a green card', async (t) => {
  const app = await boot(t, { dbThrows: true });
  const res = await app.get('roland');
  assert.equal(res.status, 503);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'SETUP_STATUS_UNAVAILABLE');
});

// ── wiring ──────────────────────────────────────────────────────────────────

test('server.js: mounted behind admin.all, with no module guard, ABOVE the voice-guarded /api/admin', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const m = src.match(/app\.use\(\s*'\/api\/admin\/setup-status'[\s\S]*?\);/);
  assert.ok(m, 'server.js mounts /api/admin/setup-status');
  assert.match(m[0], /requirePermission\('admin\.all'\)/);
  assert.doesNotMatch(m[0], /requireModule|voiceModule|voiceSurface/);
  const here = src.indexOf("app.use('/api/admin/setup-status'");
  const admin = src.indexOf("app.use('/api/admin', voiceModule");
  assert.ok(here > -1 && admin > -1 && here < admin, 'must be mounted before /api/admin');
});
