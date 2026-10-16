'use strict';

/**
 * Referrals from the chair (queue item 54, R3, path a).
 *
 *   1  a hygienist's referral lands pending_signoff (or approved when sign-off
 *      is not required), office = the VISIT's, patient = the visit's stored
 *      PatNum + appointment-snapshot name
 *   +  the body can never name a patient or an office
 *   +  dark unless the practice has TC and referrals is on for the office
 *   +  the chairside picker reads only this office's ACTIVE specialists
 *   4  zero Open Dental: the referral calls make no OD request
 *
 * A composite fake: hyg statements go to FakeHygDb (as every hyg test), the TC
 * referral statements to the TC FakeTenantDb — one tenant database in
 * production, two fakes here because each fake only knows its own module's SQL.
 *
 * Test patient 12827 (roland) only.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const { FakeOd, FakeHygDb, bootHygApp, api, apptRow, patientRow, operatoryRow } = require('./hygTestUtils');
const { FakeTenantDb } = require('../tc/tcTestUtils');

const DATE = '2026-09-08';
const Q = `?office=roland&date=${DATE}`;
const REF = '/api/hyg/visit/900001/referral?office=roland';

/** Hyg SQL to the hyg fake; TC referral SQL (and its transactions) to the TC fake. */
class CompositeDb extends FakeHygDb {
  constructor() {
    super();
    this.tc = new FakeTenantDb();
  }

  async query(sql, params = []) {
    const text = String(sql).trim();
    // A test can fail ONLY the sign-off move's audit row (action UPDATE on a
    // referral), to prove create + submit commit or roll back together.
    if (
      this.failMoveAudit &&
      /INSERT INTO audit_log/i.test(text) &&
      params.includes('UPDATE') &&
      params.includes('tc_referral')
    ) {
      throw new Error('simulated audit outage on the submit');
    }
    if (/^BEGIN$/i.test(text)) {
      // Postgres semantics for the TC side: remember, so ROLLBACK can restore.
      this.snapshot = new Map([...this.tc.tables].map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
      return { rows: [], rowCount: 0 };
    }
    if (/^ROLLBACK$/i.test(text)) {
      // Every table the transaction touched — including one first created
      // after BEGIN, which the snapshot does not name and must come back empty.
      for (const [k, live] of this.tc.tables) {
        const before = (this.snapshot && this.snapshot.get(k)) || [];
        live.length = 0;
        live.push(...before);
      }
      return { rows: [], rowCount: 0 };
    }
    if (/^COMMIT$/i.test(text) || /\btc_(referral|cases)/i.test(text)) {
      return this.tc.query(sql, params);
    }
    return super.query(sql, params);
  }

  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }
}

function od() {
  return new FakeOd(
    {
      '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: `${DATE} 08:00:00` })],
      '/operatories': [operatoryRow()],
      '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
      '/providers': [
        { ProvNum: 1, Abbr: 'DOC1' },
        { ProvNum: 7, Abbr: 'HYG1' },
      ],
      '/patients/12827': patientRow(),
      '/procedurelogs': [],
      '/procedurelogs/GroupNotes': [],
    },
    { writes: {} }
  );
}

function switchReferrals(t, byOffice) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_referrals_enabled' && byOffice ? { key, value: byOffice, updated_at: new Date(), updated_by: null } : null;
  tcReferrals.resetCacheForTests();
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcReferrals.resetCacheForTests();
  });
}

async function boot(t, opts = {}) {
  const db = new CompositeDb();
  const client = od();
  const app = await bootHygApp({ modules: ['hyg', 'tc'], db, od: client, ...opts });
  t.after(() => app.close());
  return { ...app, db, client };
}

/** Open the visit and read it once, so the appointment snapshot (the name) is stored. */
async function openVisit(app) {
  assert.equal((await api(app.baseUrl, 'POST', `/api/hyg/visit/900001/open${Q}`)).status, 200);
  assert.equal((await api(app.baseUrl, 'GET', `/api/hyg/visit/900001${Q}`)).status, 200);
}

const BODY = { reason: 'Deep pockets #30, perio evaluation', teeth: [30], urgency: 'soon' };

test('1: a chairside referral lands pending_signoff, for the VISIT\'s patient and office', async (t) => {
  switchReferrals(t, { roland: true });
  const app = await boot(t);
  await openVisit(app);
  const odBefore = app.client.calls ? app.client.calls.length : null;

  const r = await api(app.baseUrl, 'POST', REF, { body: BODY });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ref = r.body.referral;
  assert.equal(ref.status, 'pending_signoff');
  assert.equal(ref.officeId, 'roland');
  assert.equal(ref.odPatientId, 12827);
  assert.ok(ref.patientName.length > 0, 'the snapshot name');
  assert.equal(ref.sourceKind, 'hyg_visit');
  assert.equal(ref.sourceRef, app.db.hyg_visit[0].visit_id);
  assert.equal(ref.createdBy, 'hygienist@carein.ai');
  assert.deepEqual(ref.events.map((e) => [e.fromStatus, e.toStatus]), [
    [null, 'draft'],
    ['draft', 'pending_signoff'],
  ]);
  const audits = app.db.audit.filter((a) => a.resource_type === 'tc_referral');
  assert.deepEqual(audits.map((a) => [a.action, a.prior_state]), [
    ['CREATE', null],
    ['UPDATE', 'draft'],
  ]);
  // 4: no Open Dental request was made for the referral.
  if (odBefore !== null) assert.equal(app.client.calls.length, odBefore);

  const list = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/referrals?office=roland');
  assert.deepEqual(list.body.referrals.map((x) => x.referralId), [ref.referralId]);
});

test('1: when the office does not require sign-off, it lands approved', async (t) => {
  switchReferrals(t, { roland: true });
  const app = await boot(t);
  app.db.tc.table('tc_referral_settings').push({ office_id: 'roland', signoff_required: false, autosend_on_approval: false, updated_by: 'boss@carein.ai' });
  await openVisit(app);
  const r = await api(app.baseUrl, 'POST', REF, { body: BODY });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.referral.status, 'approved');
});

test('the body can never name the patient or the office', async (t) => {
  switchReferrals(t, { roland: true });
  const app = await boot(t);
  await openVisit(app);
  for (const extra of [{ odPatientId: 7115 }, { patientName: 'Somebody' }, { officeId: 'valley' }, { status: 'approved' }]) {
    const r = await api(app.baseUrl, 'POST', REF, { body: { ...BODY, ...extra } });
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
  assert.equal(app.db.tc.table('tc_referrals').length, 0);
});

test('refusals: no visit yet, referrals off, TC not entitled', async (t) => {
  switchReferrals(t, { roland: true });
  const app = await boot(t);
  const none = await api(app.baseUrl, 'POST', REF, { body: BODY });
  assert.equal(none.status, 404);
  assert.equal(none.body.code, 'VISIT_NOT_FOUND');

  tcReferrals.resetCacheForTests();
  registry.getPlatformSetting = async () => null;
  await openVisit(app);
  const off = await api(app.baseUrl, 'POST', REF, { body: BODY });
  assert.equal(off.status, 403);
  assert.equal(off.body.code, 'REFERRALS_DISABLED');
  assert.equal(app.db.tc.table('tc_referrals').length, 0);
});

test('refusals: a practice without TC gets MODULE_NOT_ENTITLED', async (t) => {
  switchReferrals(t, { roland: true });
  const app = await boot(t, { modules: ['hyg'] });
  await openVisit(app);
  const r = await api(app.baseUrl, 'POST', REF, { body: BODY });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'MODULE_NOT_ENTITLED');
});

test("the chairside picker reads this office's ACTIVE specialists only", async (t) => {
  switchReferrals(t, { roland: true, valley: true });
  const app = await boot(t);
  const dir = app.db.tc.table('tc_referral_directory');
  dir.push({ entry_id: randomUUID(), office_id: 'roland', practice_name: 'River Endodontics', active: true });
  dir.push({ entry_id: randomUUID(), office_id: 'roland', practice_name: 'Old Ortho', active: false });
  dir.push({ entry_id: randomUUID(), office_id: 'valley', practice_name: 'Valley Oral Surgery', active: true });
  const r = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/referral-directory?office=roland');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.entries.map((e) => e.practiceName), ['River Endodontics']);
});

test('a hygienist can name a specialist; another office\'s specialist is refused', async (t) => {
  switchReferrals(t, { roland: true, valley: true });
  const app = await boot(t);
  await openVisit(app);
  const mine = randomUUID();
  const theirs = randomUUID();
  app.db.tc.table('tc_referral_directory').push(
    { entry_id: mine, office_id: 'roland', practice_name: 'River Periodontics', active: true },
    { entry_id: theirs, office_id: 'valley', practice_name: 'Valley Perio', active: true }
  );
  const bad = await api(app.baseUrl, 'POST', REF, { body: { ...BODY, directoryEntryId: theirs } });
  assert.equal(bad.status, 404);
  const ok = await api(app.baseUrl, 'POST', REF, { body: { ...BODY, directoryEntryId: mine } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.referral.practiceName, 'River Periodontics');
});

test('create and submit are ONE transaction: a failed sign-off move leaves no stray draft', async (t) => {
  switchReferrals(t, { roland: true });
  const app = await boot(t);
  await openVisit(app);
  app.db.failMoveAudit = true;
  const r = await api(app.baseUrl, 'POST', REF, { body: BODY });
  assert.equal(r.status, 500);
  assert.equal(app.db.tc.table('tc_referrals').length, 0, 'no draft a hygienist could never finish');
  assert.equal(app.db.tc.table('tc_referral_events').length, 0);
  // ... and a retry, once the outage passes, creates exactly one.
  app.db.failMoveAudit = false;
  const again = await api(app.baseUrl, 'POST', REF, { body: BODY });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(app.db.tc.table('tc_referrals').length, 1);
});

// ── R4 (item 55): the X-ray snipped chairside ───────────────────────────────

const blob = require('../../services/tc/referralAttachmentStore');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

function memoryBlob(t) {
  const saved = { isConfigured: blob.isConfigured, putAttachment: blob.putAttachment };
  const objects = new Map();
  blob.isConfigured = () => true;
  blob.putAttachment = async ({ tenantSlug, data, contentType }) => {
    const key = blob.buildKey({ tenantSlug, contentType });
    objects.set(key, data);
    return { key, bytes: data.length };
  };
  t.after(() => Object.assign(blob, saved));
  return objects;
}

async function attach(app, referralId, data = PNG) {
  const form = new FormData();
  form.append('file', new Blob([data], { type: 'image/png' }), 'xray.png');
  const res = await fetch(`${app.baseUrl}/api/hyg/visit/900001/referrals/${referralId}/attachments?office=roland`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token' }, // as hygTestUtils.api
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

test('R4: the hygienist attaches the X-ray to the referral THIS visit started', async (t) => {
  switchReferrals(t, { roland: true });
  const objects = memoryBlob(t);
  const app = await boot(t);
  await openVisit(app);
  const ref = (await api(app.baseUrl, 'POST', REF, { body: BODY })).body.referral;
  const r = await attach(app, ref.referralId);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.attachment.contentType, 'image/png');
  assert.equal(r.body.attachment.uploadedBy, 'hygienist@carein.ai');
  assert.equal(objects.size, 1);
  assert.equal(app.db.tc.table('tc_referral_attachments').length, 1);
});

test("R4: not onto a referral this visit did not start (another visit's, or TC's)", async (t) => {
  switchReferrals(t, { roland: true });
  memoryBlob(t);
  const app = await boot(t);
  await openVisit(app);
  const other = randomUUID();
  app.db.tc.table('tc_referrals').push({
    referral_id: other,
    office_id: 'roland',
    od_patient_id: 12827,
    patient_name: 'Test 2, Stedi',
    source_kind: 'case',
    source_ref: randomUUID(),
    teeth: '[]',
    status: 'draft',
  });
  const r = await attach(app, other);
  assert.equal(r.status, 404);
  assert.equal(app.db.tc.table('tc_referral_attachments').length, 0);
});

test('R4: referrals off → refused before the file is read', async (t) => {
  switchReferrals(t, null);
  memoryBlob(t);
  const app = await boot(t);
  const r = await attach(app, randomUUID());
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'REFERRALS_DISABLED');
});
