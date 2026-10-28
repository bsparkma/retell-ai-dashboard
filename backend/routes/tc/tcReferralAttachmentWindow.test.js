'use strict';

/**
 * R6.9a — the STAFF upload window on referrals, widened so the specialist's
 * returned report or fax can be attached after the referral went out.
 *
 *   W  the TC staff route takes a file while a referral is a draft, awaiting
 *      sign-off, sent, acknowledged or patient seen
 *   S  approved, closed, cancelled and declined stay SHUT: 409 REFERRAL_LOCKED,
 *      in a sentence that names the window; nothing stored, no row, no audit
 *   N  R4 otherwise unchanged: the cap of 5 still refuses the sixth after send;
 *      no DELETE on either route; another office's referral is a 404
 *   D  the doctor's sign-off route and the hygiene route keep R4's window
 *
 * Blob storage is faked: nothing really uploads. Test patient only (roland
 * 12827); names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const blob = require('../../services/tc/referralAttachmentStore');
const attachments = require('./referralAttachments');
const { bootTcApp, auditRows } = require('./tcTestUtils');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const DOCTOR = { role: 'doctor', user: { email: 'doctor@carein.ai', name: 'Doc', tenantId: 'x' } };
const TC = '/api/tc/referrals';
const SIGNOFF = '/api/tc/referrals/signoff';

const OPEN = ['draft', 'pending_signoff', 'sent', 'acknowledged', 'patient_seen'];
const SHUT = ['approved', 'closed', 'cancelled', 'declined'];
const STAFF_LOCKED =
  'Files can be added only while a referral is a draft, awaiting sign-off, sent, acknowledged, or the patient has been seen.';

function fakeStore(t) {
  const saved = Object.fromEntries(['isConfigured', 'putAttachment', 'getAttachment'].map((k) => [k, blob[k]]));
  const objects = new Map();
  blob.isConfigured = () => true;
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
    status: 'draft',
    status_changed_at: new Date(),
    created_at: new Date(),
    ...over,
  };
  db.table('tc_referrals').push(row);
  return row;
}

async function upload(baseUrl, office, referralId, { base = TC, name = 'report.png' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), name);
  const res = await fetch(`${baseUrl}${base}/${referralId}/attachments?office=${office}`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}

const attachAudits = (db) => auditRows(db).filter((a) => a.resource_type === 'tc_referral_attachment');

// ── W: the window ───────────────────────────────────────────────────────────

test('W: staff attach while a draft, awaiting sign-off, sent, acknowledged or patient seen', async (t) => {
  switchReferrals(t);
  const objects = fakeStore(t);
  const { baseUrl, db } = await boot(t);
  for (const status of OPEN) {
    const ref = seedReferral(db, { status });
    const r = await upload(baseUrl, 'roland', ref.referral_id);
    assert.equal(r.status, 201, `${status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.attachment.contentType, 'image/png');
    assert.equal(db.table('tc_referrals').find((x) => x.referral_id === ref.referral_id).status, status, 'never a move');
  }
  assert.equal(objects.size, OPEN.length);
  assert.equal(db.table('tc_referral_attachments').length, OPEN.length);
  assert.equal(attachAudits(db).filter((a) => a.action === 'CREATE').length, OPEN.length);
});

// ── S: still shut ───────────────────────────────────────────────────────────

test('S: approved, closed, cancelled, declined stay shut — 409 REFERRAL_LOCKED, nothing stored', async (t) => {
  switchReferrals(t);
  const objects = fakeStore(t);
  const { baseUrl, db } = await boot(t);
  for (const status of SHUT) {
    const ref = seedReferral(db, { status });
    const r = await upload(baseUrl, 'roland', ref.referral_id);
    assert.equal(r.status, 409, status);
    assert.equal(r.body.code, 'REFERRAL_LOCKED', status);
    assert.equal(r.body.error, STAFF_LOCKED, status);
  }
  assert.equal(objects.size, 0, 'no blob written');
  assert.equal(db.table('tc_referral_attachments').length, 0, 'no row');
  assert.equal(attachAudits(db).length, 0, 'no audit');
});

// ── N: R4 otherwise unchanged ───────────────────────────────────────────────

test('N: the cap of 5 is unchanged after send — the sixth is refused honestly and not stored', async (t) => {
  switchReferrals(t);
  const objects = fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db, { status: 'sent' });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await upload(baseUrl, 'roland', ref.referral_id, { name: `fax${i}.png` })).status, 201);
  }
  const sixth = await upload(baseUrl, 'roland', ref.referral_id, { name: 'fax6.png' });
  assert.equal(sixth.status, 409);
  assert.equal(sixth.body.code, 'ATTACHMENT_LIMIT');
  assert.equal(sixth.body.error, 'A referral can carry at most 5 files.');
  assert.equal(objects.size, 5);
  assert.equal(db.table('tc_referral_attachments').length, 5);
});

test('N: no delete, ever — DELETE is a 404 on the staff and the sign-off routes, and the file stays', async (t) => {
  switchReferrals(t);
  fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db, { status: 'acknowledged' });
  const a = (await upload(baseUrl, 'roland', ref.referral_id)).body.attachment;
  for (const base of [TC, SIGNOFF]) {
    const res = await fetch(`${baseUrl}${base}/${ref.referral_id}/attachments/${a.attachmentId}?office=roland`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 404, base);
  }
  assert.equal(db.table('tc_referral_attachments').length, 1);
});

test("N: office is server-derived — valley cannot add to roland's sent referral", async (t) => {
  switchReferrals(t, { roland: true, valley: true });
  const objects = fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db, { status: 'sent' });
  assert.equal((await upload(baseUrl, 'valley', ref.referral_id)).status, 404);
  assert.equal(objects.size, 0);
  assert.equal(db.table('tc_referral_attachments').length, 0);
});

// ── D: the other routes keep R4's window ────────────────────────────────────

test("D: the doctor's sign-off route still refuses once the referral is sent", async (t) => {
  switchReferrals(t);
  const objects = fakeStore(t);
  const { baseUrl, db } = await boot(t, DOCTOR);
  for (const status of ['sent', 'acknowledged', 'patient_seen']) {
    const ref = seedReferral(db, { status });
    const r = await upload(baseUrl, 'roland', ref.referral_id, { base: SIGNOFF });
    assert.notEqual(r.status, 201, status);
    assert.ok([404, 409].includes(r.status), `${status}: ${r.status}`);
  }
  assert.equal(objects.size, 0);
  assert.equal(db.table('tc_referral_attachments').length, 0);
});

test("D: R4's default window is unchanged, and only the TC staff route widens it", () => {
  assert.deepEqual([...attachments.ATTACHABLE_STATUSES], ['draft', 'pending_signoff']);
  const backend = path.join(__dirname, '..', '..');
  const widen = /attachableStatuses\s*:/;
  assert.match(fs.readFileSync(path.join(__dirname, 'referrals.js'), 'utf8'), widen);
  for (const f of ['routes/tc/referralSignoff.js', 'routes/hyg/visit.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(backend, f), 'utf8'), widen, f);
  }
});

test('the attachment path reaches no Open Dental code and sends nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, 'referralAttachments.js'), 'utf8');
  assert.doesNotMatch(src, /require\([^)]*(openDental|odOffices|commlog|referralSend|acsEmail|mail)/i);
});
