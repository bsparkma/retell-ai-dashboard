'use strict';

/**
 * /api/tc/referrals — referral foundations (queue item 52, R1).
 *
 * By acceptance row:
 *   1  directory CRUD, office-scoped: the other office's entries are invisible
 *      and unactionable; email validated; active/inactive; a referenced entry
 *      cannot be deleted
 *   2  settings persist and round-trip; the two policies are admin-only; the
 *      env safety pins only ever push toward safe
 *   3  tc_referrals_enabled OFF → every route but /status refuses
 *   +  every change audited after it persisted; zero Open Dental (this harness
 *      has no OD client at all)
 *
 * Synthetic specialists only; no patient appears in R1.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const ENV_KEYS = [
  'TC_REFERRALS_ENABLED_ROLAND',
  'TC_REFERRALS_ENABLED_VALLEY',
  'REFERRAL_SIGNOFF_REQUIRED_ROLAND',
  'REFERRAL_AUTOSEND_ON_APPROVAL_ROLAND',
];

function switchReferrals(t, byOffice) {
  const orig = registry.getPlatformSetting;
  const env = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  registry.getPlatformSetting = async (key) =>
    key === 'tc_referrals_enabled' && byOffice ? { key, value: byOffice, updated_at: new Date(), updated_by: null } : null;
  tcReferrals.resetCacheForTests();
  t.after(() => {
    registry.getPlatformSetting = orig;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    tcReferrals.resetCacheForTests();
  });
}

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

const DIR = (office) => `/api/tc/referrals/directory?office=${office}`;
const ONE = (office, id) => `/api/tc/referrals/directory/${id}?office=${office}`;
const SETTINGS = (office) => `/api/tc/referrals/settings?office=${office}`;
const STATUS = (office) => `/api/tc/referrals/status?office=${office}`;

const ENDO = {
  practiceName: 'River Endodontics',
  specialistName: 'Dr. Endo Example',
  specialty: 'Endodontics',
  contactPerson: 'Front Desk',
  email: 'referrals@endo.example',
  phone: '479-555-0100',
  fax: '479-555-0101',
  notes: 'Closed Fridays',
  preferredFormatNotes: 'PDF with periapical',
};

// ── 3: dark ─────────────────────────────────────────────────────────────────

test('3: switched off → /status says so and every other route refuses', async (t) => {
  switchReferrals(t, null);
  const { baseUrl, db } = await boot(t);
  const status = await api(baseUrl, 'GET', STATUS('roland'));
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { success: true, office: 'roland', enabled: false });
  for (const [method, path, body] of [
    ['GET', DIR('roland')],
    ['POST', DIR('roland'), ENDO],
    ['PUT', ONE('roland', randomUUID()), ENDO],
    ['DELETE', ONE('roland', randomUUID())],
    ['GET', SETTINGS('roland')],
    ['PUT', SETTINGS('roland'), { signoffRequired: false }],
  ]) {
    const r = await api(baseUrl, method, path, body);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.body.code, 'REFERRALS_DISABLED');
  }
  assert.equal(db.table('tc_referral_directory').length, 0);
  assert.equal(db.table('tc_referral_settings').length, 0);
});

test('3: on for roland only → valley still refuses', async (t) => {
  switchReferrals(t, { roland: true });
  const { baseUrl } = await boot(t);
  assert.equal((await api(baseUrl, 'GET', DIR('roland'))).status, 200);
  assert.equal((await api(baseUrl, 'GET', DIR('valley'))).status, 403);
  assert.equal((await api(baseUrl, 'GET', STATUS('valley'))).body.enabled, false);
});

test('3: the env break-glass =false beats a stored ON', async (t) => {
  switchReferrals(t, { roland: true });
  process.env.TC_REFERRALS_ENABLED_ROLAND = 'false';
  const { baseUrl } = await boot(t);
  assert.equal((await api(baseUrl, 'GET', DIR('roland'))).status, 403);
});

test('a hygienist (tc.hygiene only) cannot reach referrals', async (t) => {
  switchReferrals(t, { roland: true });
  const { baseUrl } = await boot(t, { role: 'hygiene' });
  assert.equal((await api(baseUrl, 'GET', DIR('roland'))).status, 403);
});

// ── 1: the directory ────────────────────────────────────────────────────────

test('1: add, list, edit, deactivate and delete a specialist — each persisted and audited', async (t) => {
  switchReferrals(t, { roland: true });
  const { baseUrl, db } = await boot(t, { role: 'tc' });

  const created = await api(baseUrl, 'POST', DIR('roland'), ENDO);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const entry = created.body.entry;
  assert.equal(entry.practiceName, 'River Endodontics');
  assert.equal(entry.officeId, 'roland');
  assert.equal(entry.active, true);
  assert.equal(entry.createdBy, 'tc@carein.ai');
  assert.equal(db.table('tc_referral_directory')[0].office_id, 'roland');

  let list = await api(baseUrl, 'GET', DIR('roland'));
  assert.deepEqual(list.body.entries.map((e) => e.practiceName), ['River Endodontics']);

  const edited = await api(baseUrl, 'PUT', ONE('roland', entry.entryId), { ...ENDO, phone: '479-555-0199', active: false });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.entry.phone, '479-555-0199');
  assert.equal(edited.body.entry.active, false);

  list = await api(baseUrl, 'GET', DIR('roland'));
  assert.equal(list.body.entries.length, 0, 'inactive entries are hidden by default');
  list = await api(baseUrl, 'GET', `${DIR('roland')}&includeInactive=true`);
  assert.equal(list.body.entries.length, 1);

  const removed = await api(baseUrl, 'DELETE', ONE('roland', entry.entryId));
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(db.table('tc_referral_directory').length, 0);

  const audits = auditRows(db).filter((a) => a.resource_type === 'tc_referral_directory');
  assert.deepEqual(audits.map((a) => [a.action, a.resource_id, a.prior_state]), [
    ['CREATE', entry.entryId, null],
    ['UPDATE', entry.entryId, 'active'],
    ['DELETE', entry.entryId, 'inactive'],
  ]);
});

test('1: the form is validated — a practice name is required and an email must look like one', async (t) => {
  switchReferrals(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  assert.equal((await api(baseUrl, 'POST', DIR('roland'), { ...ENDO, practiceName: '  ' })).status, 400);
  const bad = await api(baseUrl, 'POST', DIR('roland'), { ...ENDO, email: 'not-an-email' });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.body), /email/i);
  // A body can never name the office or the owner.
  assert.equal((await api(baseUrl, 'POST', DIR('roland'), { ...ENDO, officeId: 'valley' })).status, 400);
  // Blank email is fine: not every office has one.
  assert.equal((await api(baseUrl, 'POST', DIR('roland'), { practiceName: 'Ortho Group', email: '' })).status, 201);
  assert.equal(db.table('tc_referral_directory').length, 1);
  assert.ok(!auditRows(db).some((a) => a.resource_type === 'tc_referral_directory' && a.action !== 'CREATE'));
});

test("1: office-scoped — valley never sees or touches roland's specialists", async (t) => {
  switchReferrals(t, { roland: true, valley: true });
  const { baseUrl, db } = await boot(t);
  const roland = (await api(baseUrl, 'POST', DIR('roland'), ENDO)).body.entry;
  assert.equal((await api(baseUrl, 'GET', `${DIR('valley')}&includeInactive=true`)).body.entries.length, 0);
  assert.equal((await api(baseUrl, 'PUT', ONE('valley', roland.entryId), { ...ENDO, phone: 'x' })).status, 404);
  assert.equal((await api(baseUrl, 'DELETE', ONE('valley', roland.entryId))).status, 404);
  assert.equal(db.table('tc_referral_directory')[0].phone, ENDO.phone, 'untouched');
});

test('1: a specialist named on a referral cannot be deleted — deactivate instead', async (t) => {
  switchReferrals(t, { roland: true });
  const { baseUrl, db } = await boot(t);
  const entry = (await api(baseUrl, 'POST', DIR('roland'), ENDO)).body.entry;
  db.table('tc_referrals').push({
    referral_id: randomUUID(),
    office_id: 'roland',
    od_patient_id: 12827,
    patient_name: 'Test 2, Stedi',
    directory_entry_id: entry.entryId,
    status: 'draft',
  });
  const r = await api(baseUrl, 'DELETE', ONE('roland', entry.entryId));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'DIRECTORY_ENTRY_IN_USE');
  assert.equal(db.table('tc_referral_directory').length, 1);
  assert.ok(!auditRows(db).some((a) => a.action === 'DELETE'));
});

test('1: bad ids are a 400', async (t) => {
  switchReferrals(t, { roland: true });
  const { baseUrl } = await boot(t);
  assert.equal((await api(baseUrl, 'PUT', ONE('roland', 'nope'), ENDO)).status, 400);
  assert.equal((await api(baseUrl, 'DELETE', ONE('roland', 'nope'))).status, 400);
});

// ── 2: settings ─────────────────────────────────────────────────────────────

test('2: defaults are sign-off ON and auto-send OFF; an admin change persists and round-trips, audited', async (t) => {
  switchReferrals(t, { roland: true });
  const { baseUrl, db } = await boot(t);

  let s = await api(baseUrl, 'GET', SETTINGS('roland'));
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.signoffRequired, { value: true, source: 'default' });
  assert.deepEqual(s.body.autosendOnApproval, { value: false, source: 'default' });
  assert.equal(s.body.canEdit, true);

  const put = await api(baseUrl, 'PUT', SETTINGS('roland'), { signoffRequired: false });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.signoffRequired, { value: false, source: 'office' });
  assert.deepEqual(put.body.autosendOnApproval, { value: false, source: 'office' }, 'the untouched one is kept');
  assert.equal(put.body.updatedBy, 'tc@carein.ai');

  s = await api(baseUrl, 'GET', SETTINGS('roland'));
  assert.deepEqual(s.body.signoffRequired, { value: false, source: 'office' });

  // Item 53: auto-send with sign-off OFF is refused, not stored — a referral
  // would go out before any doctor read it.
  const unsafe = await api(baseUrl, 'PUT', SETTINGS('roland'), { autosendOnApproval: true });
  assert.equal(unsafe.status, 409);
  assert.equal(unsafe.body.code, 'REFERRAL_POLICY_UNSAFE');
  s = await api(baseUrl, 'GET', SETTINGS('roland'));
  assert.deepEqual([s.body.signoffRequired.value, s.body.autosendOnApproval.value], [false, false]);

  // Auto-send together with sign-off is fine.
  await api(baseUrl, 'PUT', SETTINGS('roland'), { signoffRequired: true, autosendOnApproval: true });
  s = await api(baseUrl, 'GET', SETTINGS('roland'));
  assert.deepEqual([s.body.signoffRequired.value, s.body.autosendOnApproval.value], [true, true]);

  const audits = auditRows(db).filter((a) => a.resource_type === 'tc_referral_settings');
  assert.deepEqual(audits.map((a) => [a.action, a.resource_id, a.prior_state]), [
    ['UPDATE', 'roland', 'signoff_on:autosend_off'],
    ['UPDATE', 'roland', 'signoff_off:autosend_off'],
  ]);
});

test('2: settings are per office', async (t) => {
  switchReferrals(t, { roland: true, valley: true });
  const { baseUrl } = await boot(t);
  await api(baseUrl, 'PUT', SETTINGS('roland'), { signoffRequired: false });
  const valley = await api(baseUrl, 'GET', SETTINGS('valley'));
  assert.deepEqual(valley.body.signoffRequired, { value: true, source: 'default' });
});

test('2: the policies are admin-only — a tc or office user reads them but cannot change them', async (t) => {
  switchReferrals(t, { roland: true });
  for (const role of ['tc', 'office']) {
    await t.test(role, async (tt) => {
      const { baseUrl, db } = await boot(tt, { role });
      const s = await api(baseUrl, 'GET', SETTINGS('roland'));
      assert.equal(s.status, 200);
      assert.equal(s.body.canEdit, false);
      const r = await api(baseUrl, 'PUT', SETTINGS('roland'), { signoffRequired: false });
      assert.equal(r.status, 403);
      assert.equal(db.table('tc_referral_settings').length, 0);
    });
  }
});

test('2: an empty or unknown change is refused', async (t) => {
  switchReferrals(t, { roland: true });
  const { baseUrl } = await boot(t);
  assert.equal((await api(baseUrl, 'PUT', SETTINGS('roland'), {})).status, 400);
  assert.equal((await api(baseUrl, 'PUT', SETTINGS('roland'), { signoffRequired: 'no' })).status, 400);
  assert.equal((await api(baseUrl, 'PUT', SETTINGS('roland'), { sendNow: true })).status, 400);
});

test('2: env safety pins only push toward safe: sign-off ON, auto-send OFF', async (t) => {
  switchReferrals(t, { roland: true });
  const { baseUrl } = await boot(t);
  // The office stores auto-send ON (allowed alongside sign-off ON, item 53), so
  // the auto-send pin below is seen overriding a stored TRUE.
  assert.equal((await api(baseUrl, 'PUT', SETTINGS('roland'), { signoffRequired: true, autosendOnApproval: true })).status, 200);

  process.env.REFERRAL_SIGNOFF_REQUIRED_ROLAND = 'true';
  process.env.REFERRAL_AUTOSEND_ON_APPROVAL_ROLAND = 'false';
  let s = await api(baseUrl, 'GET', SETTINGS('roland'));
  assert.deepEqual(s.body.signoffRequired, { value: true, source: 'env' });
  assert.deepEqual(s.body.autosendOnApproval, { value: false, source: 'env' });

  // The unsafe direction is never honored from the environment.
  process.env.REFERRAL_SIGNOFF_REQUIRED_ROLAND = 'false';
  process.env.REFERRAL_AUTOSEND_ON_APPROVAL_ROLAND = 'true';
  await api(baseUrl, 'PUT', SETTINGS('roland'), { signoffRequired: true, autosendOnApproval: false });
  s = await api(baseUrl, 'GET', SETTINGS('roland'));
  assert.deepEqual(s.body.signoffRequired, { value: true, source: 'office' });
  assert.deepEqual(s.body.autosendOnApproval, { value: false, source: 'office' });
});
