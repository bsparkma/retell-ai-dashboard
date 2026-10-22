'use strict';

/**
 * R6.2 — the doctor adds files at sign-off, through the R4 upload handler.
 *
 *   - only while the referral awaits sign-off (where the doctor may edit);
 *     a draft is not the doctor's (404), an approved or declined one is locked
 *   - every R4 rule holds on this route too: the BYTES decide the type, a
 *     file over 10 MB is cut off, ≤5 a referral, storage unconfigured → 503
 *     with no row and no audit, cross-office refused, one audit row per upload
 *   - the route is the doctor's (tc.referral_signoff): a tc user is refused;
 *     the TC route stays closed to a doctor
 *   - there is no delete, on either route
 *
 * The blob store is the same in-memory stand-in R4's tests use (no Azure);
 * the route, multer, the DB writes and the audit are the real ones.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const blob = require('../../services/tc/referralAttachmentStore');
const { bootTcApp, auditRows } = require('./tcTestUtils');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const TEXT = Buffer.from('MZ this is not an image at all, just text pretending..........');
const DOCTOR = { role: 'doctor', user: { email: 'doctor@carein.ai', name: 'Doc', tenantId: 'x' } };
const SIGNOFF = '/api/tc/referrals/signoff';
const TC = '/api/tc/referrals';

function fakeStore(t, { configured = true } = {}) {
  const saved = Object.fromEntries(['isConfigured', 'putAttachment', 'getAttachment'].map((k) => [k, blob[k]]));
  const objects = new Map();
  blob.isConfigured = () => configured;
  blob.putAttachment = async ({ tenantSlug, data, contentType }) => {
    const key = blob.buildKey({ tenantSlug, contentType });
    objects.set(key, Buffer.from(data));
    return { key, bytes: data.length };
  };
  blob.getAttachment = async (key) => {
    if (!objects.has(key)) throw new Error('BlobNotFound');
    return objects.get(key);
  };
  t.after(() => Object.assign(blob, saved));
  return objects;
}

function switchReferrals(t, byOffice = { roland: true }) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_referrals_enabled' && byOffice ? { key, value: byOffice, updated_at: new Date(), updated_by: null } : null;
  tcReferrals.resetCacheForTests();
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcReferrals.resetCacheForTests();
  });
}

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

function seedReferral(db, over = {}) {
  const row = {
    referral_id: randomUUID(),
    office_id: 'roland',
    od_patient_id: 12827,
    patient_name: 'Test 2, Stedi',
    source_kind: 'case',
    source_ref: '',
    teeth: '[]',
    status: 'pending_signoff',
    status_changed_at: new Date(),
    created_at: new Date(),
    ...over,
  };
  db.table('tc_referrals').push(row);
  return row;
}

async function upload(baseUrl, office, referralId, data, { base = SIGNOFF, name = 'xray.png', type = 'image/png' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([data], { type }), name);
  const res = await fetch(`${baseUrl}${base}/${referralId}/attachments?office=${office}`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}

const attachAudits = (db) => auditRows(db).filter((a) => a.resource_type === 'tc_referral_attachment');

test('the doctor adds a file to a referral awaiting sign-off: stored, attributed, audited once', async (t) => {
  switchReferrals(t);
  const objects = fakeStore(t);
  const { baseUrl, db } = await boot(t, DOCTOR);
  const ref = seedReferral(db);
  const r = await upload(baseUrl, 'roland', ref.referral_id, PNG);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.attachment.uploadedBy, 'doctor@carein.ai');
  assert.equal(r.body.attachment.contentType, 'image/png');
  assert.equal(r.body.attachment.blobKey, undefined, 'the key never leaves the server');
  assert.equal(objects.size, 1);
  assert.equal(db.table('tc_referral_attachments').length, 1);
  assert.deepEqual(attachAudits(db).map((a) => [a.action, a.source_ref]), [['CREATE', `referral:${ref.referral_id}`]]);
  // And the doctor can list it straight back.
  const list = await fetch(`${baseUrl}${SIGNOFF}/${ref.referral_id}/attachments?office=roland`).then((x) => x.json());
  assert.deepEqual(list.attachments.map((a) => a.attachmentId), [r.body.attachment.attachmentId]);
});

test('only while it awaits sign-off: a draft is not the doctor’s (404); approved / declined are locked (409)', async (t) => {
  switchReferrals(t);
  fakeStore(t);
  const { baseUrl, db } = await boot(t, DOCTOR);
  const draft = seedReferral(db, { status: 'draft' });
  assert.equal((await upload(baseUrl, 'roland', draft.referral_id, PNG)).status, 404);
  for (const status of ['approved', 'declined']) {
    const ref = seedReferral(db, { status });
    const r = await upload(baseUrl, 'roland', ref.referral_id, PNG);
    assert.equal(r.status, 409, status);
    assert.equal(r.body.code, 'REFERRAL_LOCKED', status);
  }
  for (const status of ['sent', 'cancelled', 'closed']) {
    const ref = seedReferral(db, { status });
    assert.equal((await upload(baseUrl, 'roland', ref.referral_id, PNG)).status, 404, status);
  }
  assert.equal(db.table('tc_referral_attachments').length, 0);
  assert.equal(attachAudits(db).length, 0);
});

test('R4 limits hold on the doctor’s route: bytes decide the type, >10 MB cut, at most 5', async (t) => {
  switchReferrals(t);
  fakeStore(t);
  const { baseUrl, db } = await boot(t, DOCTOR);
  const ref = seedReferral(db);
  const fake = await upload(baseUrl, 'roland', ref.referral_id, TEXT, { name: 'xray.png', type: 'image/png' });
  assert.equal(fake.status, 415);
  assert.equal(fake.body.code, 'ATTACHMENT_TYPE_NOT_ALLOWED');

  const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024 + 1 - PNG.length, 0)]);
  const tooBig = await upload(baseUrl, 'roland', ref.referral_id, big);
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.code, 'ATTACHMENT_TOO_LARGE');

  for (let i = 0; i < 5; i += 1) assert.equal((await upload(baseUrl, 'roland', ref.referral_id, PNG)).status, 201);
  const sixth = await upload(baseUrl, 'roland', ref.referral_id, PNG);
  assert.equal(sixth.status, 409);
  assert.equal(sixth.body.code, 'ATTACHMENT_LIMIT');
  assert.equal(db.table('tc_referral_attachments').length, 5);
});

test('storage unconfigured → 503, nothing stored, no row, no audit', async (t) => {
  switchReferrals(t);
  const objects = fakeStore(t, { configured: false });
  const { baseUrl, db } = await boot(t, DOCTOR);
  const ref = seedReferral(db);
  const r = await upload(baseUrl, 'roland', ref.referral_id, PNG);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'REFERRAL_STORAGE_UNAVAILABLE');
  assert.equal(objects.size, 0);
  assert.equal(db.table('tc_referral_attachments').length, 0);
  assert.equal(attachAudits(db).length, 0);
});

test("cross-office: valley cannot add to roland's referral at sign-off", async (t) => {
  switchReferrals(t, { roland: true, valley: true });
  fakeStore(t);
  const { baseUrl, db } = await boot(t, DOCTOR);
  const ref = seedReferral(db);
  assert.equal((await upload(baseUrl, 'valley', ref.referral_id, PNG)).status, 404);
  assert.equal(db.table('tc_referral_attachments').length, 0);
});

test('the gates: a tc user may not use the doctor’s route; a doctor may not use the TC route; dark → 403', async (t) => {
  switchReferrals(t);
  fakeStore(t);
  const tc = await boot(t, { role: 'tc' });
  const ref = seedReferral(tc.db);
  assert.equal((await upload(tc.baseUrl, 'roland', ref.referral_id, PNG)).status, 403, 'tc → sign-off route');
  const doc = await boot(t, { ...DOCTOR, db: tc.db });
  assert.equal((await upload(doc.baseUrl, 'roland', ref.referral_id, PNG, { base: TC })).status, 403, 'doctor → TC route');
  assert.equal(tc.db.table('tc_referral_attachments').length, 0);
});

test('dark: referrals off → the doctor’s upload is refused', async (t) => {
  switchReferrals(t, null);
  fakeStore(t);
  const { baseUrl, db } = await boot(t, DOCTOR);
  const ref = seedReferral(db);
  assert.equal((await upload(baseUrl, 'roland', ref.referral_id, PNG)).status, 403);
});

test('immutable: there is no delete for a referral file, on either route', async (t) => {
  switchReferrals(t);
  fakeStore(t);
  const admin = await boot(t);
  const ref = seedReferral(admin.db);
  const a = (await upload(admin.baseUrl, 'roland', ref.referral_id, PNG)).body.attachment;
  for (const base of [SIGNOFF, TC]) {
    const res = await fetch(`${admin.baseUrl}${base}/${ref.referral_id}/attachments/${a.attachmentId}?office=roland`, { method: 'DELETE' });
    assert.equal(res.status, 404, base);
  }
  assert.equal(admin.db.table('tc_referral_attachments').length, 1);
});
