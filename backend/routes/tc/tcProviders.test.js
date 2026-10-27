'use strict';

/**
 * The provider directory: /api/tc/providers, its Open Dental import, the
 * doctor's read seam, and the referring provider on the two referral field
 * edits (hub + sign-off).
 *
 *   L  list: office-scoped, active-only by default, `canEdit` per role
 *   W  writes: admin + office only (tc, doctor, hygiene refused); strict
 *      bodies, smuggled fields 400; every change audited; no DELETE route
 *   I  import: ONE read of the request office's own Open Dental, GET-only;
 *      adds new ProvNums, updates linked names, never deletes or deactivates,
 *      never touches a hand-added row; hidden / hygienist / nameless skipped
 *      and counted; an OD failure or a not-connected office writes nothing
 *   S  the doctor reads ACTIVE providers through /referrals/signoff/providers
 *   F  referringProvider rides the hub edit and the doctor's edit, named in
 *      the history line
 *
 * The per-office OD clients are the REAL instances with apiGetRaw patched (the
 * handles are frozen). Provider names are synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { before, after, beforeEach, afterEach } = test;
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const odOffices = require('../../config/odOffices');
const { planImport } = require('../../services/tc/providerImport');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

/** Distinct rows per practice, so an assertion proves WHICH database was read. */
const OD_PROVIDERS = {
  roland: [
    { ProvNum: 1, FName: 'Avery', LName: 'Roland', Suffix: 'DDS', IsHidden: 'false', IsHygienist: 'false' },
    { ProvNum: 2, FName: 'Blake', LName: 'Roland', Suffix: 'DMD', IsHidden: false, IsHygienist: false },
    { ProvNum: 3, FName: 'Former', LName: 'Doctor', Suffix: 'DDS', IsHidden: 'true', IsHygienist: 'false' },
    { ProvNum: 4, FName: 'Hy', LName: 'Gienist', Suffix: 'RDH', IsHidden: 'false', IsHygienist: 'true' },
    { ProvNum: 5, FName: '', LName: '', Abbr: '', IsHidden: 'false', IsHygienist: 'false' },
  ],
  valley: [{ ProvNum: 1, FName: 'Casey', LName: 'Valley', Suffix: 'DDS', IsHidden: 'false', IsHygienist: 'false' }],
};

const savedEnv = {};
let odCalls = [];
let patched = [];
/** Per-office override: return this { ok, status, data } instead of the list. */
let odAnswer = {};

before(() => {
  for (const k of ['OPENDENTAL_CUSTOMER_KEY', 'OPENDENTAL_CUSTOMER_KEY_VALLEY', 'OPENDENTAL_ALLOW_MOCK']) savedEnv[k] = process.env[k];
  process.env.OPENDENTAL_CUSTOMER_KEY = 'test-roland-customer-key';
  process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = 'test-valley-customer-key';
  delete process.env.OPENDENTAL_ALLOW_MOCK;
  odOffices.resetOdOfficeCache();
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  odOffices.resetOdOfficeCache();
});

beforeEach(() => {
  odCalls = [];
  patched = [];
  odAnswer = {};
  for (const officeKey of ['roland', 'valley']) {
    const { client } = odOffices.getOdOffice(officeKey);
    patched.push({ client, original: client.apiGetRaw });
    client.apiGetRaw = async (path, params) => {
      odCalls.push({ office: officeKey, path, params });
      if (odAnswer[officeKey]) return odAnswer[officeKey];
      return path === '/providers' ? { ok: true, status: 200, data: OD_PROVIDERS[officeKey] } : { ok: false, status: 404, data: null };
    };
  }
});

afterEach(() => {
  for (const { client, original } of patched) client.apiGetRaw = original;
  patched = [];
});

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

const P = (p = '', office = 'roland', qs = '') => `/api/tc/providers${p}?office=${office}${qs}`;
const providerAudits = (db) => auditRows(db).filter((a) => a.resource_type === 'tc_provider_directory');

function seedProvider(db, over = {}) {
  const row = {
    provider_id: randomUUID(),
    office_id: 'roland',
    name: 'Hand Added',
    credential_suffix: '',
    active: true,
    od_prov_num: null,
    created_by: 'seed',
    created_at: new Date(),
    updated_by: 'seed',
    updated_at: new Date(),
    ...over,
  };
  db.table('tc_provider_directory').push(row);
  return row;
}

// ── L / W ───────────────────────────────────────────────────────────────────

test('L/W: add, list A→Z active-only, edit and deactivate; each change audited; office-scoped', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'office' });
  const a = await api(baseUrl, 'POST', P(), { name: 'Zed Smith', credentialSuffix: 'DDS' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.deepEqual(
    [a.body.entry.name, a.body.entry.credentialSuffix, a.body.entry.active, a.body.entry.odProvNum, a.body.entry.officeId],
    ['Zed Smith', 'DDS', true, null, 'roland']
  );
  const b = await api(baseUrl, 'POST', P(), { name: 'Amy Jones' });
  assert.equal(b.status, 201);

  const list = await api(baseUrl, 'GET', P());
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.entries.map((e) => e.name), ['Amy Jones', 'Zed Smith']);
  assert.equal(list.body.canEdit, true);

  const off = await api(baseUrl, 'PUT', P(`/${b.body.entry.providerId}`), { name: 'Amy Jones', active: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.entry.active, false);
  assert.deepEqual((await api(baseUrl, 'GET', P())).body.entries.map((e) => e.name), ['Zed Smith']);
  assert.deepEqual(
    (await api(baseUrl, 'GET', P('', 'roland', '&includeInactive=true'))).body.entries.map((e) => e.name),
    ['Amy Jones', 'Zed Smith']
  );

  // Another office sees none of it, and cannot edit it.
  assert.deepEqual((await api(baseUrl, 'GET', P('', 'valley'))).body.entries, []);
  const cross = await api(baseUrl, 'PUT', P(`/${a.body.entry.providerId}`, 'valley'), { name: 'Hijack' });
  assert.equal(cross.status, 404);

  const audits = providerAudits(db);
  assert.deepEqual(audits.map((x) => x.action), ['CREATE', 'CREATE', 'UPDATE']);
  assert.equal(audits[2].prior_state, 'active');
});

test('W: strict bodies — a smuggled office, id or ProvNum is a 400 and nothing is stored', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'admin' });
  for (const body of [
    { name: 'X', office: 'valley' },
    { name: 'X', officeId: 'valley' },
    { name: 'X', odProvNum: 7 },
    { name: 'X', providerId: randomUUID() },
    { name: '' },
    { name: 'X'.repeat(201) },
    { name: 'X', credentialSuffix: 'D'.repeat(41) },
  ]) {
    const r = await api(baseUrl, 'POST', P(), body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(db.table('tc_provider_directory').length, 0);
  assert.equal((await api(baseUrl, 'PUT', P('/not-a-uuid'), { name: 'X' })).status, 400);
});

test('W: only admin + office change the list; tc reads it (canEdit false) and is refused every write', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const row = seedProvider(db);
  const list = await api(baseUrl, 'GET', P());
  assert.equal(list.status, 200);
  assert.equal(list.body.canEdit, false);
  assert.equal(list.body.entries.length, 1);
  for (const [method, p, body] of [
    ['POST', '', { name: 'X' }],
    ['PUT', `/${row.provider_id}`, { name: 'X' }],
    ['POST', '/import', {}],
  ]) {
    const r = await api(baseUrl, method, P(p), body);
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.equal(r.body.code, 'FORBIDDEN');
  }
  assert.equal(odCalls.length, 0, 'a refused import never asks Open Dental');
  assert.equal(db.table('tc_provider_directory')[0].name, 'Hand Added');
});

test('W: a doctor and a hygienist do not reach /api/tc/providers at all (tc.full)', async (t) => {
  for (const role of ['doctor', 'hygiene']) {
    const { baseUrl } = await boot(t, { role, user: { email: `${role}@carein.ai`, name: role, tenantId: 'x' } });
    assert.equal((await api(baseUrl, 'GET', P())).status, 403, role);
  }
});

test('W: there is no delete', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'admin' });
  const row = seedProvider(db);
  const r = await api(baseUrl, 'DELETE', P(`/${row.provider_id}`));
  assert.equal(r.status, 404);
  assert.equal(db.table('tc_provider_directory').length, 1);
});

// ── I: the import ───────────────────────────────────────────────────────────

test('I: one GET of THIS office\'s Open Dental; adds the practising non-hygienists, counts the rest', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'office' });
  const r = await api(baseUrl, 'POST', P('/import'), {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(
    [r.body.added, r.body.updated, r.body.unchanged, r.body.skippedHidden, r.body.skippedHygienists, r.body.skippedNoName],
    [2, 0, 0, 1, 1, 1]
  );
  assert.deepEqual(
    r.body.entries.map((e) => [e.name, e.credentialSuffix, e.odProvNum, e.active]),
    [
      ['Avery Roland', 'DDS', 1, true],
      ['Blake Roland', 'DMD', 2, true],
    ]
  );
  assert.deepEqual(odCalls.map((c) => [c.office, c.path]), [['roland', '/providers']], "only roland's OD, one list read");
  assert.deepEqual(providerAudits(db).map((a) => a.action), ['CREATE', 'CREATE']);

  // Valley's import reads valley's database and lands in valley's list only.
  odCalls = [];
  const v = await api(baseUrl, 'POST', P('/import', 'valley'), {});
  assert.equal(v.status, 200);
  assert.deepEqual(v.body.entries.map((e) => [e.officeId, e.name]), [['valley', 'Casey Valley']]);
  assert.deepEqual(odCalls.map((c) => c.office), ['valley']);
  assert.equal((await api(baseUrl, 'GET', P())).body.entries.length, 2, "roland's list is untouched");
});

test('I: re-import updates linked names only — never deletes, never deactivates, never touches a hand-added row', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'admin' });
  const hand = seedProvider(db, { name: 'Avery Roland', credential_suffix: '' }); // same name, no ProvNum
  const renamed = seedProvider(db, { name: 'Old Name', credential_suffix: 'DDS', od_prov_num: '1', active: true });
  const deactivated = seedProvider(db, { name: 'Blake Roland', credential_suffix: 'DMD', od_prov_num: '2', active: false });
  const gone = seedProvider(db, { name: 'Left The Practice', od_prov_num: '99', active: true }); // no longer in OD

  const r = await api(baseUrl, 'POST', P('/import'), {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.added, r.body.updated, r.body.unchanged], [0, 1, 1]);

  const byId = new Map(db.table('tc_provider_directory').map((row) => [row.provider_id, row]));
  assert.equal(byId.get(renamed.provider_id).name, 'Avery Roland');
  assert.equal(byId.get(deactivated.provider_id).active, false, 'an import never reactivates');
  assert.equal(byId.get(gone.provider_id).active, true, 'an import never deactivates');
  assert.equal(byId.get(hand.provider_id).name, 'Avery Roland');
  assert.equal(byId.get(hand.provider_id).od_prov_num, null, 'a hand-added row is never linked or changed');
  assert.equal(db.table('tc_provider_directory').length, 4, 'nothing deleted, nothing added');
  assert.deepEqual(providerAudits(db).map((a) => [a.action, a.resource_id]), [['UPDATE', renamed.provider_id]]);
});

test('I: an empty Open Dental suffix never blanks one staff typed', () => {
  const plan = planImport(
    [{ ProvNum: 7, FName: 'Dana', LName: 'Test', Suffix: '', IsHidden: 'false', IsHygienist: 'false' }],
    [{ provider_id: 'p7', name: 'Dana Old', credential_suffix: 'DDS', od_prov_num: '7' }]
  );
  assert.deepEqual(plan.updates, [{ providerId: 'p7', name: 'Dana Test', credentialSuffix: 'DDS' }]);
});

test('I: Open Dental unreachable → 502, not connected → 503; nothing is written either way', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'admin' });
  odAnswer.roland = { ok: false, status: 500, data: null, error: 'boom' };
  const down = await api(baseUrl, 'POST', P('/import'), {});
  assert.equal(down.status, 502);
  assert.equal(down.body.code, 'OD_READ_FAILED');

  const keep = process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
  delete process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
  odOffices.resetOdOfficeCache();
  t.after(() => {
    process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = keep;
    odOffices.resetOdOfficeCache();
  });
  const unkeyed = await api(baseUrl, 'POST', P('/import', 'valley'), {});
  assert.equal(unkeyed.status, 503);
  assert.equal(unkeyed.body.code, 'OFFICE_NOT_CONNECTED');

  assert.equal(db.table('tc_provider_directory').length, 0);
  assert.equal(providerAudits(db).length, 0);
});

test('I: a body field (an office, a list) is a 400 and Open Dental is never asked', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'admin' });
  for (const body of [{ office: 'valley' }, { providers: [{ ProvNum: 1 }] }]) {
    const r = await api(baseUrl, 'POST', P('/import'), body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(odCalls.length, 0);
  assert.equal(db.table('tc_provider_directory').length, 0);
});

test('I: a list that does not end inside the page budget is refused, not half-merged', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'admin' });
  const page = Array.from({ length: 100 }, (_, i) => ({ ProvNum: i + 1, FName: 'P', LName: String(i), IsHidden: 'false' }));
  odAnswer.roland = { ok: true, status: 200, data: page };
  const r = await api(baseUrl, 'POST', P('/import'), {});
  assert.equal(r.status, 502);
  assert.equal(db.table('tc_provider_directory').length, 0);
  assert.equal(odCalls.length, 10, 'stops at the page budget');
  assert.ok(odCalls.every((c) => c.path === '/providers'));
});

// ── S: the doctor's read ────────────────────────────────────────────────────

function switchReferrals(t) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_referrals_enabled' ? { key, value: { roland: true }, updated_at: new Date(), updated_by: null } : null;
  tcReferrals.resetCacheForTests();
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcReferrals.resetCacheForTests();
  });
}

test('S: a doctor reads ACTIVE providers through the sign-off seam', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t, { role: 'doctor', user: { email: 'doctor@carein.ai', name: 'Doc', tenantId: 'x' } });
  seedProvider(db, { name: 'Active Doc' });
  seedProvider(db, { name: 'Inactive Doc', active: false });
  seedProvider(db, { name: 'Valley Doc', office_id: 'valley' });
  const r = await api(baseUrl, 'GET', '/api/tc/referrals/signoff/providers?office=roland');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.entries.map((e) => e.name), ['Active Doc']);
});

// ── F: the referring provider on the two field edits ────────────────────────

test('F: the hub edit and the doctor edit both change the referring provider, named in the history', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t, { role: 'admin' });
  const caseRow = { case_id: randomUUID(), office_id: 'roland', patient_name: 'Test 2, Stedi', od_patient_id: 12827, status: 'pending_tc' };
  db.table('tc_cases').push(caseRow);
  const created = await api(baseUrl, 'POST', '/api/tc/referrals?office=roland', {
    source: { caseId: caseRow.case_id },
    referral: { reason: 'Endo eval', referringProvider: 'Typed Name' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.referral.referralId;

  const hub = await api(baseUrl, 'PATCH', `/api/tc/referrals/${id}/fields?office=roland`, { referringProvider: 'Avery Roland, DDS' });
  assert.equal(hub.status, 200, JSON.stringify(hub.body));
  assert.equal(hub.body.referral.referringProvider, 'Avery Roland, DDS');

  assert.equal((await api(baseUrl, 'POST', `/api/tc/referrals/${id}/submit?office=roland`, {})).status, 200);
  const doc = await api(baseUrl, 'PATCH', `/api/tc/referrals/signoff/${id}/fields?office=roland`, { referringProvider: 'Other Name' });
  assert.equal(doc.status, 200, JSON.stringify(doc.body));
  assert.equal(doc.body.referral.referringProvider, 'Other Name');

  const notes = db
    .table('tc_referral_events')
    .filter((e) => e.referral_id === id && (e.verb === 'edit' || e.verb === 'doctor_edit'))
    .map((e) => [e.verb, e.note]);
  assert.deepEqual(notes, [
    ['edit', 'Changed referring provider'],
    ['doctor_edit', 'Changed referring provider'],
  ]);

  // The same value again is a no-op, and too long is a 400.
  const same = await api(baseUrl, 'PATCH', `/api/tc/referrals/signoff/${id}/fields?office=roland`, { referringProvider: 'Other Name' });
  assert.equal(same.status, 200);
  const long = await api(baseUrl, 'PATCH', `/api/tc/referrals/signoff/${id}/fields?office=roland`, { referringProvider: 'x'.repeat(201) });
  assert.equal(long.status, 400);
});
