'use strict';

/**
 * Referral attachments (queue item 55, R4).
 *
 *   1  type / size / count limits enforced server-side — by the BYTES, not the
 *      client's claimed type or filename; ≤10 MB; ≤5 a referral
 *   2  storage not configured, or the container missing → an honest 503 and NO
 *      metadata row claiming success
 *   3  every view writes an audit row (a second look is a second row); a failed
 *      audit refuses the view — nothing is served
 *   4  cross-office fetch (and upload) refused
 *   +  filenames sanitized; files only while draft / pending sign-off; the
 *      doctor can open the files of a referral they may read, not a draft's
 *
 * The blob store is an in-memory stand-in (no Azure in a unit test); the
 * route, multer, the DB writes and the audit are the real ones.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const blob = require('../../services/tc/referralAttachmentStore');
const { bootTcApp, auditRows } = require('./tcTestUtils');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 3)]);
const TEXT = Buffer.from('MZ this is not an image at all, just text pretending..........');

function fakeStore(t, { configured = true, putError = null } = {}) {
  const saved = Object.fromEntries(['isConfigured', 'putAttachment', 'getAttachment'].map((k) => [k, blob[k]]));
  const objects = new Map();
  blob.isConfigured = () => configured;
  blob.putAttachment = async ({ tenantSlug, data, contentType }) => {
    if (putError) throw putError;
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

async function upload(baseUrl, office, referralId, data, name = 'xray.png', type = 'image/png') {
  const form = new FormData();
  form.append('file', new Blob([data], { type }), name);
  const res = await fetch(`${baseUrl}/api/tc/referrals/${referralId}/attachments?office=${office}`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}

async function view(baseUrl, office, referralId, attachmentId, base = '/api/tc/referrals') {
  const res = await fetch(`${baseUrl}${base}/${referralId}/attachments/${attachmentId}?office=${office}`);
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}

const attachAudits = (db) => auditRows(db).filter((a) => a.resource_type === 'tc_referral_attachment');

// ── 1: limits ───────────────────────────────────────────────────────────────

test('1: an image is stored, then its row; the answer is the stored metadata (no blob key)', async (t) => {
  switchReferrals(t);
  const objects = fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db);
  const r = await upload(baseUrl, 'roland', ref.referral_id, PNG);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(
    [r.body.attachment.fileName, r.body.attachment.contentType, r.body.attachment.sizeBytes, r.body.attachment.uploadedBy],
    ['xray.png', 'image/png', PNG.length, 'tc@carein.ai']
  );
  assert.equal(r.body.attachment.blobKey, undefined, 'the key never leaves the server');
  assert.equal(objects.size, 1);
  const row = db.table('tc_referral_attachments')[0];
  assert.equal(row.office_id, 'roland');
  assert.match(row.blob_key, /^tenant\/[a-z0-9-]+\/tc\/referral\/[0-9a-f-]{36}\.png$/);
  assert.deepEqual(attachAudits(db).map((a) => [a.action, a.source_ref]), [['CREATE', `referral:${ref.referral_id}`]]);
});

test('1: the BYTES decide the type — not the claimed type or the filename', async (t) => {
  switchReferrals(t);
  fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db);
  // Text dressed as a PNG: refused.
  let r = await upload(baseUrl, 'roland', ref.referral_id, TEXT, 'xray.png', 'image/png');
  assert.equal(r.status, 415);
  assert.equal(r.body.code, 'ATTACHMENT_TYPE_NOT_ALLOWED');
  // A real JPEG named .pdf and claimed as a PDF: stored as what it IS.
  r = await upload(baseUrl, 'roland', ref.referral_id, JPEG, 'scan.pdf', 'application/pdf');
  assert.equal(r.status, 201);
  assert.equal(r.body.attachment.contentType, 'image/jpeg');
  // A PDF is fine.
  r = await upload(baseUrl, 'roland', ref.referral_id, PDF, 'letter.pdf', 'application/pdf');
  assert.equal(r.body.attachment.contentType, 'application/pdf');
  assert.equal(db.table('tc_referral_attachments').length, 2);
});

test('1: over 10 MB is refused before anything is stored', async (t) => {
  switchReferrals(t);
  const objects = fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db);
  const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024 + 1 - PNG.length, 0)]);
  const r = await upload(baseUrl, 'roland', ref.referral_id, big);
  assert.equal(r.status, 413);
  assert.equal(r.body.code, 'ATTACHMENT_TOO_LARGE');
  assert.equal(objects.size, 0);
  assert.equal(db.table('tc_referral_attachments').length, 0);
});

test('1: at most 5 a referral — the sixth is refused and not stored', async (t) => {
  switchReferrals(t);
  const objects = fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db);
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await upload(baseUrl, 'roland', ref.referral_id, PNG, `x${i}.png`)).status, 201);
  }
  const sixth = await upload(baseUrl, 'roland', ref.referral_id, PNG, 'x6.png');
  assert.equal(sixth.status, 409);
  assert.equal(sixth.body.code, 'ATTACHMENT_LIMIT');
  assert.equal(objects.size, 5);
  assert.equal(db.table('tc_referral_attachments').length, 5);
});

test('filenames are sanitized: no path, no quotes or control characters', async (t) => {
  switchReferrals(t);
  fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db);
  const r = await upload(baseUrl, 'roland', ref.referral_id, PNG, '..\\..\\etc\\pass<w>ord|x.png');
  assert.equal(r.status, 201);
  assert.equal(r.body.attachment.fileName, 'passwordx.png');
  // Quotes and control characters are pinned on the sanitizer directly: a
  // multipart transport may percent-encode a quote in flight.
  const { sanitizeFilename } = require('./referralAttachments');
  assert.equal(sanitizeFilename('a"b\r\nc.png', 'image/png'), 'abc.png');
  assert.equal(sanitizeFilename('/tmp/../x.pdf', 'application/pdf'), 'x.pdf');
  assert.equal(sanitizeFilename('"""', 'image/png'), 'attachment.png');
  assert.equal(sanitizeFilename('', 'application/pdf'), 'attachment.pdf');
});

test('files only while the referral is a draft or awaiting sign-off', async (t) => {
  switchReferrals(t);
  fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const pending = seedReferral(db, { status: 'pending_signoff' });
  assert.equal((await upload(baseUrl, 'roland', pending.referral_id, PNG)).status, 201);
  const approved = seedReferral(db, { status: 'approved' });
  const r = await upload(baseUrl, 'roland', approved.referral_id, PNG);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'REFERRAL_LOCKED');
});

// ── 2: fail closed ──────────────────────────────────────────────────────────

test('2: storage not configured → 503, nothing stored, no row, no audit', async (t) => {
  switchReferrals(t);
  const objects = fakeStore(t, { configured: false });
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db);
  const r = await upload(baseUrl, 'roland', ref.referral_id, PNG);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'REFERRAL_STORAGE_UNAVAILABLE');
  assert.match(r.body.error, /Nothing was saved/);
  assert.equal(objects.size, 0);
  assert.equal(db.table('tc_referral_attachments').length, 0);
  assert.equal(attachAudits(db).length, 0);
});

test('2: the container is missing → the same honest 503, and no row claims the file', async (t) => {
  switchReferrals(t);
  const err = Object.assign(new Error('container missing'), { code: 'REFERRAL_STORAGE_UNAVAILABLE' });
  fakeStore(t, { putError: err });
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db);
  const r = await upload(baseUrl, 'roland', ref.referral_id, PNG);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'REFERRAL_STORAGE_UNAVAILABLE');
  assert.equal(db.table('tc_referral_attachments').length, 0);
});

test('2: any other storage failure is a 500 — still no row, never "uploaded"', async (t) => {
  switchReferrals(t);
  fakeStore(t, { putError: new Error('socket hang up') });
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db);
  const r = await upload(baseUrl, 'roland', ref.referral_id, PNG);
  assert.equal(r.status, 500);
  assert.equal(db.table('tc_referral_attachments').length, 0);
});

test('the store maps a missing container to REFERRAL_STORAGE_UNAVAILABLE', () => {
  assert.equal(blob.isMissingContainer({ code: 'ContainerNotFound' }), true);
  assert.equal(blob.isMissingContainer({ statusCode: 404 }), true);
  assert.equal(blob.isMissingContainer({ details: { errorCode: 'ContainerNotFound' } }), true);
  assert.equal(blob.isMissingContainer({ statusCode: 500 }), false);
});

// ── 3: every view audited ───────────────────────────────────────────────────

test('3: every view writes an audit row (a second look is a second row) and is not cacheable', async (t) => {
  switchReferrals(t);
  fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db);
  const a = (await upload(baseUrl, 'roland', ref.referral_id, PDF, 'letter.pdf')).body.attachment;
  for (let i = 0; i < 2; i += 1) {
    const v = await view(baseUrl, 'roland', ref.referral_id, a.attachmentId);
    assert.equal(v.status, 200);
    assert.ok(v.bytes.equals(PDF));
    assert.equal(v.headers.get('content-type'), 'application/pdf');
    assert.equal(v.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(v.headers.get('cache-control'), 'private, no-store');
    assert.match(v.headers.get('content-disposition'), /^inline; filename="letter\.pdf"/);
  }
  const reads = attachAudits(db).filter((x) => x.action === 'READ');
  assert.equal(reads.length, 2);
  assert.ok(reads.every((x) => x.resource_id === a.attachmentId && x.result === 'SUCCESS'));
  const list = await fetch(`${baseUrl}/api/tc/referrals/${ref.referral_id}/attachments?office=roland`).then((r) => r.json());
  assert.deepEqual(list.attachments.map((x) => x.attachmentId), [a.attachmentId]);
});

test('3: a failed audit refuses the view — no bytes are served', async (t) => {
  switchReferrals(t);
  fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db);
  const a = (await upload(baseUrl, 'roland', ref.referral_id, PNG)).body.attachment;
  db.onQuery(/INSERT INTO audit_log/, () => {
    throw new Error('audit store down');
  });
  const v = await view(baseUrl, 'roland', ref.referral_id, a.attachmentId);
  assert.equal(v.status, 500);
  assert.ok(!v.bytes.includes(PNG.subarray(0, 8)), 'the image was not served');
  assert.notEqual(v.headers.get('content-type'), 'image/png');
});

// ── 4: cross-office ─────────────────────────────────────────────────────────

test("4: valley can neither view, list nor add to roland's referral files", async (t) => {
  switchReferrals(t, { roland: true, valley: true });
  fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db);
  const a = (await upload(baseUrl, 'roland', ref.referral_id, PNG)).body.attachment;
  assert.equal((await view(baseUrl, 'valley', ref.referral_id, a.attachmentId)).status, 404);
  const list = await fetch(`${baseUrl}/api/tc/referrals/${ref.referral_id}/attachments?office=valley`);
  assert.equal(list.status, 404);
  assert.equal((await upload(baseUrl, 'valley', ref.referral_id, PNG)).status, 404);
  assert.equal(db.table('tc_referral_attachments').length, 1);
  assert.ok(!attachAudits(db).some((x) => x.action === 'READ'), 'no disclosure recorded, none made');
});

test('dark: referrals off → upload and view refused', async (t) => {
  switchReferrals(t, null);
  fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db);
  assert.equal((await upload(baseUrl, 'roland', ref.referral_id, PNG)).status, 403);
  assert.equal((await view(baseUrl, 'roland', ref.referral_id, randomUUID())).status, 403);
});

// ── the doctor's view ───────────────────────────────────────────────────────

test("the doctor opens the files of a referral they may read — not a draft's", async (t) => {
  switchReferrals(t);
  fakeStore(t);
  const tc = await boot(t);
  const pending = seedReferral(tc.db, { status: 'pending_signoff' });
  const draft = seedReferral(tc.db, { status: 'draft' });
  const pa = (await upload(tc.baseUrl, 'roland', pending.referral_id, PNG)).body.attachment;
  const da = (await upload(tc.baseUrl, 'roland', draft.referral_id, PNG)).body.attachment;

  const doc = await boot(t, { role: 'doctor', user: { email: 'doctor@carein.ai', name: 'Doc', tenantId: 'x' }, db: tc.db });
  const ok = await view(doc.baseUrl, 'roland', pending.referral_id, pa.attachmentId, '/api/tc/referrals/signoff');
  assert.equal(ok.status, 200);
  assert.ok(ok.bytes.equals(PNG));
  const no = await view(doc.baseUrl, 'roland', draft.referral_id, da.attachmentId, '/api/tc/referrals/signoff');
  assert.equal(no.status, 404);
  // ... and the TC route stays closed to a doctor.
  assert.equal((await view(doc.baseUrl, 'roland', pending.referral_id, pa.attachmentId)).status, 403);
  assert.equal(attachAudits(tc.db).filter((x) => x.action === 'READ').length, 1, 'the one view that served bytes');
});

// ── round 2 ────────────────────────────────────────────────────────────────

test('a file of EXACTLY 10 MB is accepted (the limit is inclusive, as the client and the DB say)', async (t) => {
  switchReferrals(t);
  fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db);
  const exact = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024 - PNG.length, 0)]);
  const r = await upload(baseUrl, 'roland', ref.referral_id, exact);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.attachment.sizeBytes, 10 * 1024 * 1024);
});

test('a UTF-8 filename is kept as typed, not latin1 mojibake', async (t) => {
  switchReferrals(t);
  fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db);
  const r = await upload(baseUrl, 'roland', ref.referral_id, PNG, 'röntgen 🦷.png');
  assert.equal(r.body.attachment.fileName, 'röntgen 🦷.png');
});

test('the list is a read: audited', async (t) => {
  switchReferrals(t);
  fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db);
  await fetch(`${baseUrl}/api/tc/referrals/${ref.referral_id}/attachments?office=roland`);
  const reads = attachAudits(db).filter((a) => a.action === 'READ');
  assert.deepEqual(reads.map((a) => [a.resource_id, a.source_ref]), [[null, `referral:${ref.referral_id}`]]);
});

test('the referral is row-locked BEFORE its status is read', async (t) => {
  switchReferrals(t);
  fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const ref = seedReferral(db);
  const order = [];
  db.onQuery(/^UPDATE tc_referrals SET updated_at = now\(\)/, () => {
    order.push('lock');
    return { rows: [], rowCount: 1 };
  });
  db.onQuery(/^SELECT .* FROM tc_referrals WHERE office_id = \$1 AND referral_id = \$2$/, (_t, params) => {
    order.push('read');
    return { rows: db.table('tc_referrals').filter((r) => r.referral_id === params[1]) };
  });
  assert.equal((await upload(baseUrl, 'roland', ref.referral_id, PNG)).status, 201);
  assert.deepEqual(order.slice(0, 2), ['lock', 'read']);
});

test('a refused attempt rolls back — the referral is not touched (not even updated_at)', async (t) => {
  switchReferrals(t);
  fakeStore(t);
  const { baseUrl, db } = await boot(t);
  const before = new Date('2026-10-16T09:00:00Z');
  const ref = seedReferral(db, { status: 'approved', updated_at: before });
  // Postgres semantics for this test: ROLLBACK restores what BEGIN saw.
  let snapshot = null;
  db.onQuery(/^BEGIN$/, () => {
    snapshot = new Map([...db.tables].map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
    return { rows: [], rowCount: 0 };
  });
  db.onQuery(/^ROLLBACK$/, () => {
    for (const [k, live] of db.tables) {
      const was = (snapshot && snapshot.get(k)) || [];
      live.length = 0;
      live.push(...was);
    }
    return { rows: [], rowCount: 0 };
  });
  const r = await upload(baseUrl, 'roland', ref.referral_id, PNG);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'REFERRAL_LOCKED');
  assert.equal(db.table('tc_referrals')[0].updated_at.toISOString(), before.toISOString());
});
