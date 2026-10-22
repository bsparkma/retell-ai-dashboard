'use strict';

/**
 * Referrals R2 (queue item 53): create / edit / submit / withdraw / cancel
 * from TC, and approve / decline from the doctor's sign-off queue.
 *
 * By acceptance row:
 *   1  the transition table is enforced server-side; illegal moves are 409
 *   2  only `doctor` and `admin` approve / decline; office, tc, hygiene,
 *      reviewer and rcm_biller get 403 — and a doctor reaches NOTHING else
 *   3  sign-off not required → submit goes straight to approved
 *   4  each transition writes exactly one audit row, and a failed audit write
 *      fails (rolls back) the transition
 *   5  (R5) one way out by email: POST /:id/send-email only, refused unless
 *      referrals, email AND referral email are all on, and for every status
 *      but approved (/send, /email, /fax stay 404)
 *   8  an office manager may set the office notification default; tc and
 *      the rest may not; nobody sets another person's choice
 *   +  the patient is derived from the case / checkout, never from the body;
 *      office-scoped; a case with referrals cannot be deleted (409, not 500)
 *
 * Test patients only (roland 12827 / 12828); names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const transitions = require('./referralTransitions');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const NOW = new Date('2026-10-16T15:00:00.000Z');

function switchReferrals(t, byOffice = { roland: true }) {
  const orig = registry.getPlatformSetting;
  const keep = {
    a: process.env.REFERRAL_SIGNOFF_REQUIRED_ROLAND,
    b: process.env.TC_REFERRALS_ENABLED_ROLAND,
  };
  delete process.env.REFERRAL_SIGNOFF_REQUIRED_ROLAND;
  delete process.env.TC_REFERRALS_ENABLED_ROLAND;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_referrals_enabled' && byOffice ? { key, value: byOffice, updated_at: new Date(), updated_by: null } : null;
  tcReferrals.resetCacheForTests();
  transitions.setClockForTests(() => NOW);
  t.after(() => {
    registry.getPlatformSetting = orig;
    if (keep.a === undefined) delete process.env.REFERRAL_SIGNOFF_REQUIRED_ROLAND;
    else process.env.REFERRAL_SIGNOFF_REQUIRED_ROLAND = keep.a;
    if (keep.b === undefined) delete process.env.TC_REFERRALS_ENABLED_ROLAND;
    else process.env.TC_REFERRALS_ENABLED_ROLAND = keep.b;
    tcReferrals.resetCacheForTests();
    transitions.setClockForTests(null);
  });
}

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

function seedCase(db, over = {}) {
  const row = {
    case_id: randomUUID(),
    office_id: 'roland',
    patient_name: 'Test 2, Stedi',
    od_patient_id: 12827,
    status: 'pending_tc',
    ...over,
  };
  db.table('tc_cases').push(row);
  return row;
}

function seedHandoff(db, over = {}) {
  const row = {
    handoff_id: randomUUID(),
    office_id: 'roland',
    source_key: `hyg-visit:${randomUUID()}:checkout`,
    od_patient_id: 12828,
    patient_name: 'Test, MangoTest',
    provider: 'DOC1',
    visit_date: '2026-10-16',
    payload: { procedures: [] },
    status: 'not_scheduled',
    case_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
  db.table('tc_checkout_handoffs').push(row);
  return row;
}

function seedEntry(db, over = {}) {
  const row = {
    entry_id: randomUUID(),
    office_id: 'roland',
    practice_name: 'River Endodontics',
    active: true,
    ...over,
  };
  db.table('tc_referral_directory').push(row);
  return row;
}

const REF = (path = '', office = 'roland') => `/api/tc/referrals${path}?office=${office}`;
const SIGN = (path = '', office = 'roland') => `/api/tc/referrals/signoff${path}?office=${office}`;

const BODY = { reason: 'Possible cracked tooth, needs endo eval', urgency: 'soon', teeth: [3] };

async function create(baseUrl, source, referral = BODY) {
  const r = await api(baseUrl, 'POST', REF(), { source, referral });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.referral;
}

/** Make the fake roll back on ROLLBACK, as Postgres does (it is a no-op by default). */
function realTransactions(db) {
  let snapshot = null;
  db.onQuery(/^BEGIN$/, () => {
    snapshot = new Map([...db.tables].map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
    return { rows: [], rowCount: 0 };
  });
  db.onQuery(/^ROLLBACK$/, () => {
    if (snapshot) {
      for (const [k, rows] of snapshot) {
        const live = db.table(k);
        live.length = 0;
        live.push(...rows);
      }
    }
    return { rows: [], rowCount: 0 };
  });
}

// ── create / edit ───────────────────────────────────────────────────────────

test('create from a case: the patient comes from the case, a draft with its event and one audit row', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const c = seedCase(db);
  const e = seedEntry(db);
  const ref = await create(baseUrl, { caseId: c.case_id }, { ...BODY, directoryEntryId: e.entry_id });
  assert.equal(ref.status, 'draft');
  assert.equal(ref.odPatientId, 12827);
  assert.equal(ref.patientName, 'Test 2, Stedi');
  assert.equal(ref.tcCaseId, c.case_id);
  assert.deepEqual([ref.sourceKind, ref.sourceRef], ['case', c.case_id]);
  assert.equal(ref.practiceName, 'River Endodontics');
  assert.deepEqual(ref.teeth, [3]);
  assert.equal(ref.createdBy, 'tc@carein.ai');
  assert.deepEqual(ref.events.map((x) => [x.fromStatus, x.toStatus, x.actor]), [[null, 'draft', 'tc@carein.ai']]);
  const audits = auditRows(db).filter((a) => a.resource_type === 'tc_referral' && a.action !== 'READ');
  assert.deepEqual(audits.map((a) => [a.action, a.resource_id]), [['CREATE', ref.referralId]]);
});

test('create from a checkout: the patient and any case come from the handoff; the list finds it by handoff', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const c = seedCase(db, { od_patient_id: 12828, patient_name: 'Test, MangoTest' });
  const h = seedHandoff(db, { case_id: c.case_id });
  const ref = await create(baseUrl, { handoffId: h.handoff_id });
  assert.deepEqual([ref.sourceKind, ref.sourceRef, ref.tcCaseId, ref.odPatientId], ['checkout', h.handoff_id, c.case_id, 12828]);
  const list = await api(baseUrl, 'GET', `${REF()}&handoffId=${h.handoff_id}`);
  assert.deepEqual(list.body.referrals.map((r) => r.referralId), [ref.referralId]);
  const byCase = await api(baseUrl, 'GET', `${REF()}&caseId=${c.case_id}`);
  assert.deepEqual(byCase.body.referrals.map((r) => r.referralId), [ref.referralId]);
});

test('the body can never name the patient, the office or the status', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const c = seedCase(db);
  for (const extra of [{ odPatientId: 7115 }, { patientName: 'Somebody' }, { status: 'approved' }, { officeId: 'valley' }]) {
    const r = await api(baseUrl, 'POST', REF(), { source: { caseId: c.case_id }, referral: { ...BODY, ...extra } });
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
  assert.equal(db.table('tc_referrals').length, 0);
});

test('refusals at create: a case with no patient, an unknown or inactive or other-office specialist', async (t) => {
  switchReferrals(t, { roland: true, valley: true });
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const noPat = seedCase(db, { od_patient_id: null });
  let r = await api(baseUrl, 'POST', REF(), { source: { caseId: noPat.case_id }, referral: BODY });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'CASE_HAS_NO_PATIENT');

  const c = seedCase(db);
  const inactive = seedEntry(db, { active: false });
  r = await api(baseUrl, 'POST', REF(), { source: { caseId: c.case_id }, referral: { ...BODY, directoryEntryId: inactive.entry_id } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'DIRECTORY_ENTRY_INACTIVE');

  const valleys = seedEntry(db, { office_id: 'valley' });
  r = await api(baseUrl, 'POST', REF(), { source: { caseId: c.case_id }, referral: { ...BODY, directoryEntryId: valleys.entry_id } });
  assert.equal(r.status, 404);

  // A roland case is not valley's to refer from.
  r = await api(baseUrl, 'POST', REF('', 'valley'), { source: { caseId: c.case_id }, referral: BODY });
  assert.equal(r.status, 404);
  assert.equal(db.table('tc_referrals').length, 0);
});

test('a draft is editable; once submitted it is not (withdraw first)', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const c = seedCase(db);
  const ref = await create(baseUrl, { caseId: c.case_id });
  let r = await api(baseUrl, 'PUT', REF(`/${ref.referralId}`), { ...BODY, narrative: 'Sensitive to biting', teeth: 'mouth' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.referral.narrative, 'Sensitive to biting');
  assert.equal(r.body.referral.teeth, 'mouth');

  assert.equal((await api(baseUrl, 'POST', REF(`/${ref.referralId}/submit`))).status, 200);
  r = await api(baseUrl, 'PUT', REF(`/${ref.referralId}`), BODY);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'REFERRAL_NOT_EDITABLE');

  assert.equal((await api(baseUrl, 'POST', REF(`/${ref.referralId}/withdraw`))).body.referral.status, 'draft');
  assert.equal((await api(baseUrl, 'PUT', REF(`/${ref.referralId}`), BODY)).status, 200);
});

// ── 1 + 3 + 4: transitions ──────────────────────────────────────────────────

test('1/4: submit → pending sign-off → approved, each step one event and one audit row naming what it was', async (t) => {
  switchReferrals(t);
  const tc = await boot(t, { role: 'tc' });
  const c = seedCase(tc.db);
  const ref = await create(tc.baseUrl, { caseId: c.case_id });
  const sub = await api(tc.baseUrl, 'POST', REF(`/${ref.referralId}/submit`));
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  assert.equal(sub.body.referral.status, 'pending_signoff');
  assert.equal(sub.body.referral.statusChangedBy, 'tc@carein.ai');
  assert.equal(sub.body.referral.statusChangedAt, NOW.toISOString());

  const doc = await boot(t, { role: 'doctor', user: { email: 'doctor@carein.ai', name: 'Doc', tenantId: 'x' }, db: tc.db });
  const ok = await api(doc.baseUrl, 'POST', SIGN(`/${ref.referralId}/approve`));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.referral.status, 'approved');
  assert.deepEqual(
    ok.body.referral.events.map((e) => [e.fromStatus, e.toStatus, e.actor]),
    [
      [null, 'draft', 'tc@carein.ai'],
      ['draft', 'pending_signoff', 'tc@carein.ai'],
      ['pending_signoff', 'approved', 'doctor@carein.ai'],
    ]
  );
  const moves = auditRows(tc.db).filter((a) => a.resource_type === 'tc_referral' && a.action === 'UPDATE');
  assert.deepEqual(moves.map((a) => [a.resource_id, a.prior_state]), [
    [ref.referralId, 'draft'],
    [ref.referralId, 'pending_signoff'],
  ]);
});

test('1: illegal moves are 409 naming where it stands — approved is terminal; nothing moves twice', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t); // admin: holds both surfaces
  const c = seedCase(db);
  const ref = await create(baseUrl, { caseId: c.case_id });
  // Not submitted yet: nothing to approve.
  let r = await api(baseUrl, 'POST', SIGN(`/${ref.referralId}/approve`));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'REFERRAL_TRANSITION_NOT_ALLOWED');
  assert.equal(r.body.currentStatus, 'draft');
  assert.equal((await api(baseUrl, 'POST', REF(`/${ref.referralId}/withdraw`))).status, 409);

  await api(baseUrl, 'POST', REF(`/${ref.referralId}/submit`));
  assert.equal((await api(baseUrl, 'POST', REF(`/${ref.referralId}/submit`))).status, 409, 'not twice');
  await api(baseUrl, 'POST', SIGN(`/${ref.referralId}/approve`));
  for (const [path, base] of [['/submit', REF], ['/withdraw', REF], ['/cancel', REF], ['/approve', SIGN], ['/decline', SIGN]]) {
    const x = await api(baseUrl, 'POST', base(`/${ref.referralId}${path}`), path === '/decline' ? { reason: 'x' } : undefined);
    assert.equal(x.status, 409, `approved is terminal: ${path}`);
    assert.equal(x.body.currentStatus, 'approved');
  }
  assert.equal(db.table('tc_referrals')[0].status, 'approved');
});

test('1: decline needs a reason, records it, and is terminal; cancel works from draft and pending', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const a = await create(baseUrl, { caseId: c.case_id });
  await api(baseUrl, 'POST', REF(`/${a.referralId}/submit`));
  assert.equal((await api(baseUrl, 'POST', SIGN(`/${a.referralId}/decline`), {})).status, 400);
  const d = await api(baseUrl, 'POST', SIGN(`/${a.referralId}/decline`), { reason: 'Treat in house first' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.referral.status, 'declined');
  assert.equal(d.body.referral.events.at(-1).note, 'Treat in house first');
  assert.equal((await api(baseUrl, 'POST', REF(`/${a.referralId}/submit`))).status, 409);

  const b = await create(baseUrl, { caseId: c.case_id });
  assert.equal((await api(baseUrl, 'POST', REF(`/${b.referralId}/cancel`))).body.referral.status, 'cancelled');
  const e = await create(baseUrl, { caseId: c.case_id });
  await api(baseUrl, 'POST', REF(`/${e.referralId}/submit`));
  assert.equal((await api(baseUrl, 'POST', REF(`/${e.referralId}/cancel`))).body.referral.status, 'cancelled');
});

test('3: sign-off not required for the office → submit goes straight to approved, and says why', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  db.table('tc_referral_settings').push({ office_id: 'roland', signoff_required: false, autosend_on_approval: false, updated_by: 'boss@carein.ai' });
  const c = seedCase(db);
  const ref = await create(baseUrl, { caseId: c.case_id });
  const r = await api(baseUrl, 'POST', REF(`/${ref.referralId}/submit`));
  assert.equal(r.status, 200);
  assert.equal(r.body.referral.status, 'approved');
  assert.equal(r.body.referral.events.at(-1).note, "Sign-off isn't required for this office");
  // ... but the env safety pin puts sign-off back on.
  process.env.REFERRAL_SIGNOFF_REQUIRED_ROLAND = 'true';
  const ref2 = await create(baseUrl, { caseId: c.case_id });
  assert.equal((await api(baseUrl, 'POST', REF(`/${ref2.referralId}/submit`))).body.referral.status, 'pending_signoff');
});

test('4: a failed audit write fails the transition — the status and its event roll back', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const ref = await create(baseUrl, { caseId: c.case_id });
  realTransactions(db);
  db.onQuery(/INSERT INTO audit_log/, () => {
    throw new Error('audit store down');
  });
  const r = await api(baseUrl, 'POST', REF(`/${ref.referralId}/submit`));
  assert.equal(r.status, 500);
  assert.equal(db.table('tc_referrals')[0].status, 'draft', 'the referral did not move');
  assert.equal(db.table('tc_referral_events').length, 1, 'only the creating event');
});

// ── 2: who signs off ────────────────────────────────────────────────────────

test('2: only doctor and admin approve or decline; every other role gets 403 and nothing moves', async (t) => {
  switchReferrals(t);
  for (const role of ['office', 'tc', 'hygiene', 'reviewer', 'rcm_biller']) {
    await t.test(role, async (tt) => {
      const { baseUrl, db } = await boot(tt, { role });
      const id = randomUUID();
      db.table('tc_referrals').push({ referral_id: id, office_id: 'roland', od_patient_id: 12827, patient_name: 'Test 2, Stedi', status: 'pending_signoff', source_kind: 'case', source_ref: '', teeth: '[]', status_changed_at: NOW });
      for (const [verb, body] of [['approve'], ['decline', { reason: 'x' }]]) {
        const r = await api(baseUrl, 'POST', SIGN(`/${id}/${verb}`), body);
        assert.equal(r.status, 403, `${role} ${verb}`);
      }
      assert.equal((await api(baseUrl, 'GET', SIGN('/queue'))).status, 403);
      assert.equal(db.table('tc_referrals')[0].status, 'pending_signoff');
    });
  }
  for (const role of ['doctor', 'admin']) {
    await t.test(role, async (tt) => {
      const { baseUrl, db } = await boot(tt, { role });
      const id = randomUUID();
      db.table('tc_referrals').push({ referral_id: id, office_id: 'roland', od_patient_id: 12827, patient_name: 'Test 2, Stedi', status: 'pending_signoff', source_kind: 'case', source_ref: '', teeth: '[]', status_changed_at: NOW, created_at: NOW });
      assert.equal((await api(baseUrl, 'GET', SIGN('/queue'))).body.referrals.length, 1);
      assert.equal((await api(baseUrl, 'POST', SIGN(`/${id}/approve`))).status, 200, role);
    });
  }
});

test('2: a doctor reaches the sign-off queue and NOTHING else in TC', async (t) => {
  switchReferrals(t);
  const { baseUrl } = await boot(t, { role: 'doctor' });
  assert.equal((await api(baseUrl, 'GET', SIGN('/summary'))).status, 200);
  for (const path of ['/api/tc/referrals?office=roland', '/api/tc/referrals/directory?office=roland', '/api/tc/cases?office=roland', '/api/tc/checkout?office=roland', '/api/tc/notification-prefs?office=roland']) {
    assert.equal((await api(baseUrl, 'GET', path)).status, 403, path);
  }
});

test('the queue is oldest first and office-scoped; the summary counts it and is dark when off', async (t) => {
  switchReferrals(t, { roland: true, valley: false });
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const first = await create(baseUrl, { caseId: c.case_id });
  const second = await create(baseUrl, { caseId: c.case_id });
  db.table('tc_referrals').find((r) => r.referral_id === first.referralId).created_at = new Date('2026-10-16T10:00:00Z');
  db.table('tc_referrals').find((r) => r.referral_id === second.referralId).created_at = new Date('2026-10-16T11:00:00Z');
  await api(baseUrl, 'POST', REF(`/${second.referralId}/submit`));
  await api(baseUrl, 'POST', REF(`/${first.referralId}/submit`));
  const q = await api(baseUrl, 'GET', SIGN('/queue'));
  assert.deepEqual(q.body.referrals.map((r) => r.referralId), [first.referralId, second.referralId]);
  const s = await api(baseUrl, 'GET', SIGN('/summary'));
  assert.equal(s.body.enabled, true);
  assert.equal(s.body.waiting, 2);
  assert.equal(s.body.newest.patientName, 'Test 2, Stedi');

  const v = await api(baseUrl, 'GET', SIGN('/summary', 'valley'));
  assert.deepEqual([v.status, v.body.enabled, v.body.waiting], [200, false, 0]);
  assert.equal((await api(baseUrl, 'GET', SIGN('/queue', 'valley'))).status, 403);
  // Roland's referral is not valley's to approve, even with valley on.
});

test("office-scoped: valley can neither read nor move roland's referral", async (t) => {
  switchReferrals(t, { roland: true, valley: true });
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const ref = await create(baseUrl, { caseId: c.case_id });
  await api(baseUrl, 'POST', REF(`/${ref.referralId}/submit`));
  assert.equal((await api(baseUrl, 'GET', REF(`/${ref.referralId}`, 'valley'))).status, 404);
  assert.equal((await api(baseUrl, 'POST', SIGN(`/${ref.referralId}/approve`, 'valley'))).status, 404);
  assert.equal((await api(baseUrl, 'GET', SIGN('/queue', 'valley'))).body.referrals.length, 0);
  assert.equal(db.table('tc_referrals')[0].status, 'pending_signoff');
});

test('dark: referrals off → every lifecycle route refuses', async (t) => {
  switchReferrals(t, null);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const r = await api(baseUrl, 'POST', REF(), { source: { caseId: c.case_id }, referral: BODY });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'REFERRALS_DISABLED');
  assert.equal((await api(baseUrl, 'GET', SIGN('/queue'))).status, 403);
});

// ── 5: one way out by email, behind three switches ──────────────────────────

/**
 * R5 (PM-authorized revision of the R2 "nothing sends" pin): the ONLY route
 * that emails a referral is POST /:id/send-email, and it is refused unless
 * tc_referrals_enabled AND tc_email_enabled AND tc_referral_email_enabled are
 * all on, and refused for every status but approved. ACS is a recording fake
 * that refuses: nothing here can send. The full send, with a configured
 * transport, is pinned in tcReferralSend.test.js.
 */
const EMAIL_ENV = [
  'TC_EMAIL_ENABLED',
  'TC_REFERRAL_EMAIL_ENABLED_ROLAND',
  'ACS_EMAIL_AUTH_MODE',
  'ACS_EMAIL_ENDPOINT',
  'ACS_EMAIL_CONNECTION',
  'ACS_EMAIL_FROM',
  'ACS_EMAIL_FROM_ROLAND',
  'ACS_EMAIL_REPLY_TO_ROLAND',
  'TC_EMAIL_PUBLIC_BASE_URL',
  'TC_EMAIL_TENANT_SLUG',
];

function emailSwitches(t) {
  const tcEmail = require('../../config/tcEmail');
  const tcReferralEmail = require('../../config/tcReferralEmail');
  const acsClient = require('../../services/messaging/acs/client');
  const keep = Object.fromEntries(EMAIL_ENV.map((k) => [k, process.env[k]]));
  for (const k of EMAIL_ENV) delete process.env[k];
  const acs = { calls: 0 };
  acsClient.setFetchForTests(async () => {
    acs.calls += 1;
    throw new Error('no network in this test');
  });
  const set = ({ email, referralEmail }) => {
    process.env.TC_EMAIL_ENABLED = String(email);
    process.env.TC_REFERRAL_EMAIL_ENABLED_ROLAND = String(referralEmail);
    tcEmail.resetCacheForTests();
    tcReferralEmail.resetCacheForTests();
  };
  t.after(() => {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    acsClient.resetForTests();
    tcEmail.resetCacheForTests();
    tcReferralEmail.resetCacheForTests();
  });
  return { set, acs };
}

test('5: /send, /email and /fax do not exist — the email route is /send-email', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const ref = await create(baseUrl, { caseId: c.case_id });
  for (const path of ['/send', '/email', '/fax']) {
    const r = await api(baseUrl, 'POST', REF(`/${ref.referralId}${path}`));
    assert.equal(r.status, 404, path);
  }
});

test('5: /send-email is refused unless referrals, email AND referral email are all on', async (t) => {
  const byOffice = { roland: true };
  switchReferrals(t, byOffice);
  const { set, acs } = emailSwitches(t);
  const { baseUrl, db } = await boot(t);
  const entry = seedEntry(db, { email: 'referrals@endo.example.test' });
  const ref = await create(baseUrl, { caseId: seedCase(db).case_id }, { ...BODY, directoryEntryId: entry.entry_id });
  assert.equal((await api(baseUrl, 'POST', REF(`/${ref.referralId}/submit`))).status, 200);
  assert.equal((await api(baseUrl, 'POST', SIGN(`/${ref.referralId}/approve`))).status, 200);
  const send = () => api(baseUrl, 'POST', REF(`/${ref.referralId}/send-email`), {});

  set({ email: true, referralEmail: false });
  let r = await send();
  assert.deepEqual([r.status, r.body.code], [403, 'REFERRAL_EMAIL_DISABLED'], 'referral email off');

  set({ email: false, referralEmail: true });
  r = await send();
  assert.deepEqual([r.status, r.body.code, r.body.reason], [501, 'FEATURE_DISABLED', 'switched_off'], 'email off');

  set({ email: true, referralEmail: true });
  byOffice.roland = false;
  tcReferrals.resetCacheForTests();
  r = await send();
  assert.deepEqual([r.status, r.body.code], [403, 'REFERRALS_DISABLED'], 'referrals off');

  // All three on: past every switch — here it stops at the unconfigured transport.
  byOffice.roland = true;
  tcReferrals.resetCacheForTests();
  r = await send();
  assert.deepEqual([r.status, r.body.code, r.body.reason], [501, 'FEATURE_DISABLED', 'not_configured'], 'all on');

  assert.equal(acs.calls, 0, 'nothing reached ACS');
  const row = db.table('tc_referrals').find((x) => x.referral_id === ref.referralId);
  assert.equal(row.status, 'approved', 'nothing moved');
});

test('5: /send-email is refused for every status but approved', async (t) => {
  switchReferrals(t);
  const { set, acs } = emailSwitches(t);
  set({ email: true, referralEmail: true });
  const { baseUrl, db } = await boot(t);
  const entry = seedEntry(db, { email: 'referrals@endo.example.test' });
  const ref = await create(baseUrl, { caseId: seedCase(db).case_id }, { ...BODY, directoryEntryId: entry.entry_id });
  const row = db.table('tc_referrals').find((x) => x.referral_id === ref.referralId);
  const statuses = ['draft', 'pending_signoff', 'sent', 'acknowledged', 'patient_seen', 'closed', 'declined', 'cancelled'];
  for (const status of statuses) {
    row.status = status;
    const r = await api(baseUrl, 'POST', REF(`/${ref.referralId}/send-email`), {});
    assert.deepEqual([r.status, r.body.code, r.body.currentStatus], [409, 'REFERRAL_TRANSITION_NOT_ALLOWED', status], status);
  }
  assert.equal(acs.calls, 0);
  assert.equal(db.table('tc_referral_events').some((e) => String(e.verb).startsWith('send')), false);
});

test('5: /send-email is the only route that emails a referral (manual), the approval the only auto path', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const routesDir = path.join(__dirname, '..');
  const callers = { sendReferral: [], sendAfterApproval: [] };
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.js$/.test(ent.name) && !/\.test\.js$/.test(ent.name)) {
        const src = fs.readFileSync(p, 'utf8');
        const rel = path.relative(routesDir, p).replace(/\\/g, '/');
        for (const fn of Object.keys(callers)) {
          const n = (src.match(new RegExp(`referralSend\\.${fn}\\(`, 'g')) || []).length;
          if (n) callers[fn].push([rel, n]);
        }
      }
    }
  };
  walk(routesDir);
  assert.deepEqual(callers.sendReferral, [['tc/referrals.js', 1]]);
  assert.deepEqual(callers.sendAfterApproval, [['tc/referralSignoff.js', 1]]);
  const referralsSrc = fs.readFileSync(path.join(__dirname, 'referrals.js'), 'utf8');
  const at = referralsSrc.indexOf("'/:id/send-email'");
  assert.ok(at > -1 && referralsSrc.indexOf('referralSend.sendReferral(') > at, 'inside the /send-email handler');
  assert.match(referralsSrc, /trigger: 'manual'/);
});

// ── cases: a case with referrals cannot be deleted ──────────────────────────

test('a case that a referral names cannot be deleted: 409, not a 500 — before and against the FK', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  await create(baseUrl, { caseId: c.case_id });
  const r = await api(baseUrl, 'DELETE', `/api/tc/cases/${c.case_id}?office=roland`);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'CASE_HAS_REFERRALS');
  assert.equal(db.table('tc_cases').length, 1);

  // A referral created between the check and the delete: the RESTRICT FK fires.
  const other = seedCase(db);
  db.onQuery(/^DELETE FROM tc_cases/, () => {
    const err = new Error('violates foreign key constraint "tc_referrals_case_fk"');
    Object.assign(err, { code: '23503', constraint: 'tc_referrals_case_fk' });
    throw err;
  });
  const raced = await api(baseUrl, 'DELETE', `/api/tc/cases/${other.case_id}?office=roland`);
  assert.equal(raced.status, 409);
  assert.equal(raced.body.code, 'CASE_HAS_REFERRALS');
});

// ── 8: office managers set the office notification default ──────────────────

test('8: an office manager sets the office notification default; tc and the rest cannot', async (t) => {
  for (const [role, allowed] of [['office', true], ['admin', true], ['tc', false]]) {
    await t.test(role, async (tt) => {
      const { baseUrl, db } = await boot(tt, { role });
      const get = await api(baseUrl, 'GET', '/api/tc/notification-prefs?office=roland');
      assert.equal(get.body.canEditOffice, allowed);
      const put = await api(baseUrl, 'PUT', '/api/tc/notification-prefs/office/referral_signoff?office=roland', { level: 'sound_banner' });
      assert.equal(put.status, allowed ? 200 : 403, role);
      assert.equal(db.table('tc_notification_defaults').length, allowed ? 1 : 0);
    });
  }
});

test('8: nobody — not even an admin — sets another person\'s own alert choice', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'admin' });
  const r = await api(baseUrl, 'PUT', '/api/tc/notification-prefs/mine/referral_signoff?office=roland', {
    level: 'silent',
    userEmail: 'someone.else@carein.ai',
  });
  assert.equal(r.status, 400);
  assert.equal(db.table('tc_notification_prefs').length, 0);
});

test("the sign-off surface opens only referrals in or past sign-off — not a TC's drafts or cancelled ones", async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const draft = await create(baseUrl, { caseId: c.case_id });
  assert.equal((await api(baseUrl, 'GET', SIGN(`/${draft.referralId}`))).status, 404, 'a draft');
  await api(baseUrl, 'POST', REF(`/${draft.referralId}/submit`));
  assert.equal((await api(baseUrl, 'GET', SIGN(`/${draft.referralId}`))).status, 200, 'pending');
  await api(baseUrl, 'POST', SIGN(`/${draft.referralId}/approve`));
  assert.equal((await api(baseUrl, 'GET', SIGN(`/${draft.referralId}`))).status, 200, 'approved: the doctor sees the result');
  const gone = await create(baseUrl, { caseId: c.case_id });
  await api(baseUrl, 'POST', REF(`/${gone.referralId}/cancel`));
  assert.equal((await api(baseUrl, 'GET', SIGN(`/${gone.referralId}`))).status, 404, 'cancelled');
});

test("the summary's newest is the latest ARRIVAL for sign-off, not the latest created", async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const older = await create(baseUrl, { caseId: c.case_id });
  const newer = await create(baseUrl, { caseId: c.case_id });
  const rows = db.table('tc_referrals');
  Object.assign(rows.find((r) => r.referral_id === older.referralId), {
    created_at: new Date('2026-10-16T09:00:00Z'),
    status: 'pending_signoff',
    status_changed_at: new Date('2026-10-16T12:00:00Z'), // withdrawn and resubmitted later
  });
  Object.assign(rows.find((r) => r.referral_id === newer.referralId), {
    created_at: new Date('2026-10-16T10:00:00Z'),
    status: 'pending_signoff',
    status_changed_at: new Date('2026-10-16T10:00:00Z'),
  });
  const s = await api(baseUrl, 'GET', SIGN('/summary'));
  assert.equal(s.body.newest.referralId, older.referralId);
  assert.equal(s.body.newest.at, '2026-10-16T12:00:00.000Z');
});
