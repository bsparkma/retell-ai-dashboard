'use strict';

/**
 * Referrals R5: emailing a referral to the specialist, end to end over HTTP
 * with a FAKE ACS (routes/emailTestUtils.js: every request is recorded and its
 * URL asserted; nothing reaches a network) and a fake blob store.
 *
 *   D  dark: the per-office switch (default OFF, env=false wins), separate
 *      from tc_referrals_enabled
 *   S  the send: the ACS request (per-office sender, reply-to, the letter,
 *      the attachments in upload order, the unsubscribe link), then — only
 *      then — approved → sent with the event + audit in one transaction
 *   O  honest ordering: refused / failed at ACS → nothing moves, a visible
 *      send_failed row, retry allowed; status is read AFTER ACS accepted
 *   C  conflicts: the audit fails or the referral moved while the email was
 *      out → a send_conflict row, a 409 that says it went out, and no
 *      second email
 *   G  gates: no email on file, inactive specialist, per-office sender only,
 *      reply-to required, the transport's kill switch and unsubscribe config
 *      unweakened, an opted-out address, the claim, strict bodies, office
 *      scoping
 *   P  packing: attachments as a prefix in upload order under the budget;
 *      the rest listed "available on request"; an unreadable file stops it
 *   A  auto-send on approval: the approval always succeeds; a failed
 *      auto-send stays approved with a send_failed row and a retry
 *   U  the email's unsubscribe link opts the specialist's address out
 *   L  the letter's words (pure)
 *
 * Test patient only: roland 12827 "Test 2, Stedi". Addresses @example.test.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const contract = require('../../tc/contract.gen.cjs');
const tcReferrals = require('../../config/tcReferrals');
const tcReferralEmail = require('../../config/tcReferralEmail');
const acsConfig = require('../../config/acsEmail');
const consent = require('../../services/messaging/consent');
const acsClient = require('../../services/messaging/acs/client');
const blob = require('../../services/tc/referralAttachmentStore');
const transitions = require('./referralTransitions');
const referralSend = require('./referralSend');
const letterText = require('./referralLetterText');
const { bootEmailApp, resetEmailHarness, apiJson, ACS_ENDPOINT, PUBLIC_BASE } = require('../emailTestUtils');
const { auditRows } = require('./tcTestUtils');

const NOW = new Date('2026-10-21T15:00:00.000Z');
const SPECIALIST = 'referrals@endo.example.test';

/** Env this file sets beyond the email harness's own, restored after each test. */
const EXTRA_ENV = [
  'TC_REFERRALS_ENABLED_ROLAND',
  'TC_REFERRALS_ENABLED_VALLEY',
  'TC_REFERRAL_EMAIL_ENABLED_ROLAND',
  'TC_REFERRAL_EMAIL_ENABLED_VALLEY',
  'REFERRAL_SIGNOFF_REQUIRED_ROLAND',
  'REFERRAL_AUTOSEND_ON_APPROVAL_ROLAND',
  'TC_EMAIL_PRACTICE_NAME_ROLAND',
  'TC_EMAIL_PRACTICE_PHONE_ROLAND',
  'TC_BLOB_ACCOUNT_URL',
  'OFFICE_TIMEZONE',
];
const SAVED = Object.fromEntries(EXTRA_ENV.map((k) => [k, process.env[k]]));
const realGetAttachment = blob.getAttachment;

test.afterEach(() => {
  resetEmailHarness();
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  blob.getAttachment = realGetAttachment;
  tcReferrals.resetCacheForTests();
  tcReferralEmail.resetCacheForTests();
  transitions.setClockForTests(null);
});

/** Records every Open Dental read the consent gate would make (email must make none). */
let odReads = 0;

/**
 * Boot with referrals + referral email ON for roland (env fallback; the
 * harness's control plane answers nothing), the transport configured.
 */
async function boot(t, { env = {}, emailOn = true, files = new Map(), ...opts } = {}) {
  for (const k of EXTRA_ENV) delete process.env[k];
  process.env.TC_REFERRALS_ENABLED_ROLAND = 'true';
  if (emailOn) process.env.TC_REFERRAL_EMAIL_ENABLED_ROLAND = 'true';
  process.env.TC_BLOB_ACCOUNT_URL = 'https://blob.example.test';
  process.env.TC_EMAIL_PRACTICE_NAME_ROLAND = 'Roland Family Dental';
  process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND = '(918) 555-0100';
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  tcReferrals.resetCacheForTests();
  tcReferralEmail.resetCacheForTests();
  transitions.setClockForTests(() => NOW);
  blob.getAttachment = async (key) => {
    if (!files.has(key)) throw new Error('blob not found');
    return files.get(key);
  };
  const app = await bootEmailApp({ env: {}, ...opts });
  odReads = 0;
  consent.setOdPatientReaderForTests(async () => {
    odReads += 1;
    return null;
  });
  t.after(() => app.close());
  return app;
}

function seedCase(db) {
  const row = {
    case_id: randomUUID(),
    office_id: 'roland',
    patient_name: 'Test 2, Stedi',
    od_patient_id: 12827,
    status: 'pending_tc',
  };
  db.table('tc_cases').push(row);
  return row;
}

function seedEntry(db, over = {}) {
  const row = {
    entry_id: randomUUID(),
    office_id: 'roland',
    practice_name: 'River Endodontics',
    specialist_name: 'Dr. Endo Example, DDS',
    specialty: 'Endodontics',
    email: 'Referrals@Endo.Example.test',
    active: true,
    ...over,
  };
  db.table('tc_referral_directory').push(row);
  return row;
}

/** A file on the referral, in upload order; its bytes in `files`. */
function seedFile(db, files, referralId, { name, ext = 'png', bytes, order }) {
  const key = `carein/tc/referral/${randomUUID()}.${ext}`;
  files.set(key, bytes);
  db.table('tc_referral_attachments').push({
    attachment_id: randomUUID(),
    office_id: 'roland',
    referral_id: referralId,
    file_name: name,
    content_type: blob.CONTENT_TYPE_BY_EXT[ext],
    size_bytes: bytes.length,
    blob_key: key,
    uploaded_by: 'tc@carein.ai',
    uploaded_at: new Date(Date.UTC(2026, 9, 20, 12, order)).toISOString(),
  });
  return key;
}

const REF = (p = '', office = 'roland') => `/api/tc/referrals${p}?office=${office}`;
const SIGN = (p = '', office = 'roland') => `/api/tc/referrals/signoff${p}?office=${office}`;

const INPUT = {
  reason: 'Possible cracked tooth, needs endo eval',
  urgency: 'soon',
  teeth: [3],
  referringProvider: 'DOC1',
  narrative: 'Sensitive to biting on #3 for two weeks.',
};

/** A referral walked to approved through the real routes, with the doctor's note. */
async function approved(baseUrl, db, { entry = seedEntry(db), doctorNote = 'Please assess #3 for a crack. {{keep}} as written.' } = {}) {
  const c = seedCase(db);
  const r = await apiJson(baseUrl, 'POST', REF(), {
    source: { caseId: c.case_id },
    referral: { ...INPUT, directoryEntryId: entry.entry_id },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.referral.referralId;
  assert.equal((await apiJson(baseUrl, 'POST', REF(`/${id}/submit`), {})).status, 200);
  if (doctorNote) {
    assert.equal((await apiJson(baseUrl, 'PATCH', SIGN(`/${id}/fields`), { doctorNote })).status, 200);
  }
  const a = await apiJson(baseUrl, 'POST', SIGN(`/${id}/approve`), {});
  assert.equal(a.status, 200, JSON.stringify(a.body));
  return { id, entry };
}

const send = (baseUrl, id, body = {}, office = 'roland') => apiJson(baseUrl, 'POST', REF(`/${id}/send-email`, office), body);
const posts = (acsCalls) => acsCalls.filter((c) => c.method === 'POST');
const referralRow = (db, id) => db.table('tc_referrals').find((r) => r.referral_id === id);
const eventsOf = (db, id) => db.table('tc_referral_events').filter((e) => e.referral_id === id);
const sendAudits = (db) => auditRows(db).filter((a) => String(a.resource_type).startsWith('tc_referral.email'));

/** Make the fake roll back on ROLLBACK, as Postgres does. */
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

/** Fail the audit INSERT for one resource type; every other audit row is stored as usual. */
function failAuditFor(db, resourceType) {
  db.onQuery(/^INSERT INTO audit_log \(/, (text, params) => {
    const cols = /^INSERT INTO audit_log \(([^)]+)\)/.exec(text)[1].split(',').map((s) => s.trim());
    const row = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
    if (row.resource_type === resourceType) throw new Error('audit store down');
    db.table('audit_log').push(row);
    return { rows: [], rowCount: 1 };
  });
}

// ── T: the table and the contract ───────────────────────────────────────────

test('T: `send` is the one new move — approved → sent, from nowhere else; the person-said verbs are unchanged', () => {
  for (const from of contract.TcReferralStatus.options) {
    for (const signoffRequired of [true, false]) {
      assert.equal(
        contract.referralNextStatus(from, 'send', { signoffRequired }),
        from === 'approved' ? 'sent' : null,
        `send from ${from}`
      );
    }
  }
  assert.equal(contract.TcReferralVerb.options.includes('send'), false, 'not a verb a route body or a mark can name');
  assert.equal(contract.TcReferralSendVerb.value, 'send');
  // The event verbs: R6's, then the three R5 adds.
  assert.deepEqual([...contract.TcReferralEventVerb.options], [
    ...contract.TC_REFERRAL_EVENT_VERBS,
    'send',
    'send_failed',
    'send_conflict',
  ]);
});

test('T: a generic move cannot claim a send', async () => {
  await assert.rejects(
    transitions.moveInTx({ user: { email: 'x@carein.ai' } }, { query: async () => ({ rows: [] }) }, {
      office: 'roland',
      referralId: randomUUID(),
      verb: 'send',
    }),
    /only through referralSend/
  );
});

test('T: referralLastSendProblem — since the last move; a conflict beats a failure; a move clears both', () => {
  const ev = (verb, note = '', toStatus = 'approved') => ({
    eventId: randomUUID(),
    fromStatus: 'approved',
    toStatus,
    actor: 'a@carein.ai',
    at: NOW.toISOString(),
    note,
    verb,
  });
  assert.equal(contract.referralLastSendProblem([ev('approve')]), null);
  assert.deepEqual(contract.referralLastSendProblem([ev('approve'), ev('send_failed', 'x')]).kind, 'failed');
  assert.equal(contract.referralLastSendProblem([ev('approve'), ev('send_failed'), ev('send_conflict', 'out')]).kind, 'conflict');
  assert.equal(contract.referralLastSendProblem([ev('approve'), ev('send_conflict'), ev('send_failed')]).kind, 'conflict');
  assert.equal(contract.referralLastSendProblem([ev('send_conflict'), ev('reopen'), ev('approve')]), null);
  assert.equal(contract.referralLastSendProblem([ev('approve'), ev('send_failed'), ev('edit')]).kind, 'failed');
  // A return is still found through the new non-move rows.
  assert.equal(contract.referralLastReturn([ev('return', 'Which tooth?', 'draft'), ev('edit')]).note, 'Which tooth?');
});

test('T: referralSendBlocker — the button decides from the server answer, and the PM copy is exact', () => {
  const on = { enabled: true, unavailable: null };
  const r = { status: 'approved', specialistEmail: SPECIALIST, sendProblem: null };
  assert.equal(contract.referralSendBlocker(r, on), null);
  assert.equal(
    contract.referralSendBlocker({ ...r, specialistEmail: null }, on),
    'No email on file — add it in Settings → Referrals, or mark sent outside the app'
  );
  assert.match(contract.referralSendBlocker(r, { enabled: false, unavailable: null }), /not switched on/);
  assert.match(contract.referralSendBlocker(r, undefined), /not switched on/);
  assert.match(contract.referralSendBlocker(r, { enabled: true, unavailable: 'office_not_configured' }), /sending address/);
  assert.match(contract.referralSendBlocker({ ...r, sendProblem: { kind: 'conflict', note: '', actor: '', at: '' } }, on), /already emailed/);
  assert.equal(contract.referralSendBlocker({ ...r, sendProblem: { kind: 'failed', note: '', actor: '', at: '' } }, on), null, 'a failure may be retried');
  assert.match(contract.referralSendBlocker({ ...r, status: 'sent' }, on), /Only an approved/);
});

// ── D: dark ─────────────────────────────────────────────────────────────────

test('D: the email switch defaults OFF — no send, no auto-send, status says so — independent of referrals', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { emailOn: false });
  db.table('tc_referral_settings').push({ office_id: 'roland', signoff_required: true, autosend_on_approval: true, updated_by: 'boss@carein.ai' });
  const { id } = await approved(baseUrl, db);
  const s = await apiJson(baseUrl, 'GET', REF('/status'));
  assert.deepEqual(s.body, { success: true, office: 'roland', enabled: true, emailSend: { enabled: false, unavailable: null } });
  const r = await send(baseUrl, id);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'REFERRAL_EMAIL_DISABLED');
  assert.equal(acsCalls.length, 0, 'auto-send did not run either');
  assert.equal(referralRow(db, id).status, 'approved');
  assert.equal(eventsOf(db, id).some((e) => String(e.verb).startsWith('send')), false);
});

test('D: env=false wins over a stored ON; referrals OFF refuses before anything', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { env: { TC_REFERRAL_EMAIL_ENABLED_ROLAND: 'false' } });
  const { id } = await approved(baseUrl, db);
  assert.equal(tcReferralEmail.sourceFor('roland'), 'env');
  assert.equal((await send(baseUrl, id)).body.code, 'REFERRAL_EMAIL_DISABLED');
  process.env.TC_REFERRALS_ENABLED_ROLAND = 'false';
  const off = await send(baseUrl, id);
  assert.equal(off.status, 403);
  assert.equal(off.body.code, 'REFERRALS_DISABLED');
  assert.equal(acsCalls.length, 0);
});

// ── S: the send ─────────────────────────────────────────────────────────────

test('S: one email to the directory address from the office sender; THEN approved → sent with event + audit', async (t) => {
  const files = new Map();
  const { baseUrl, db, acsCalls } = await boot(t, { files });
  const { id } = await approved(baseUrl, db);
  seedFile(db, files, id, { name: 'bitewing.png', bytes: Buffer.from('PNGBYTES-1'), order: 1 });
  seedFile(db, files, id, { name: 'pano.pdf', ext: 'pdf', bytes: Buffer.from('%PDF-1.4 two'), order: 2 });

  // The referral is still approved WHEN ACS is asked: nothing reads as sent first.
  const statusAtAcs = [];
  const harnessFetch = acsClient;
  harnessFetch.setFetchForTests(async (url, init) => {
    assert.ok(String(url).startsWith(`${ACS_ENDPOINT}/`), String(url));
    statusAtAcs.push(referralRow(db, id).status);
    acsCalls.push({ method: init.method, url: String(url), headers: init.headers, body: JSON.parse(String(init.body || 'null')) });
    return new Response(JSON.stringify({ id: 'op-77', status: 'Succeeded' }), { status: 202 });
  });

  const r = await send(baseUrl, id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(statusAtAcs, ['approved']);
  assert.equal(r.body.referral.status, 'sent');
  assert.equal(r.body.outcome.status, 'sent');
  assert.match(r.body.outcome.message, /River Endodontics \(referrals@endo\.example\.test\)/);

  assert.equal(posts(acsCalls).length, 1, 'exactly one email');
  const p = posts(acsCalls)[0].body;
  assert.equal(p.senderAddress, 'donotreply@roland.example.test', "the office's OWN sender");
  assert.deepEqual(p.recipients, { to: [{ address: SPECIALIST }] }, 'the directory address, lowercased');
  assert.deepEqual(p.replyTo, [{ address: 'front@roland.example.test' }]);
  assert.equal(p.content.subject, 'Referral from Roland Family Dental — Stedi T., Possible cracked tooth, needs endo eval');
  assert.deepEqual(p.attachments.map((a) => [a.name, a.contentType]), [
    ['bitewing.png', 'image/png'],
    ['pano.pdf', 'application/pdf'],
  ]);
  assert.equal(Buffer.from(p.attachments[0].contentInBase64, 'base64').toString(), 'PNGBYTES-1');
  assert.match(p.headers['List-Unsubscribe'], new RegExp(`^<${PUBLIC_BASE}/api/webhooks/email/unsubscribe\\?t=[A-Za-z0-9_-]{43}>$`));
  assert.equal(p.userEngagementTrackingDisabled, true);

  const text = p.content.plainText;
  for (const line of [
    'Dear Dr. Example,',
    'Please find our referral letter for Stedi T. below.',
    'Patient: Stedi Test 2',
    letterText.DOB_LINE,
    'We are referring Stedi for possible cracked tooth, needs endo eval.',
    'Clinical summary:\nSensitive to biting on #3 for two weeks.',
    'Teeth: #3\nUrgency: Soon',
    "Doctor's note:\nPlease assess #3 for a crack. {{keep}} as written.",
    'Attached: bitewing.png, pano.pdf',
    letterText.FINDINGS_PARAGRAPH,
    'Sincerely,\nDr. DOC1\nRoland Family Dental\n(918) 555-0100\nReply to: front@roland.example.test',
    'October 21, 2026',
    'You are receiving this email because Roland Family Dental sent your office a patient referral.',
  ]) {
    assert.ok(text.includes(line), `letter has: ${line}`);
  }
  assert.doesNotMatch(text, /available on request:/, 'everything fit');
  assert.doesNotMatch(p.content.html, /<a [^>]*>(?!Unsubscribe)/, 'no link or button but the unsubscribe link');
  assert.match(p.content.html, /\{\{keep\}\}/, "the doctor's note verbatim, tokens and all");

  const sendEvent = eventsOf(db, id).find((e) => e.verb === 'send');
  assert.equal(sendEvent.from_status, 'approved');
  assert.equal(sendEvent.to_status, 'sent');
  assert.equal(sendEvent.acs_message_id, 'op-77');
  assert.equal(sendEvent.recipient_address, SPECIALIST);
  assert.match(sendEvent.unsubscribe_token_hash, /^[0-9a-f]{64}$/);
  assert.match(sendEvent.note, /^Emailed to referrals@endo\.example\.test — 2 files attached\. The email service accepted it\.$/);
  assert.equal(referralRow(db, id).send_attempt_id, null, 'the claim is released');

  const audits = sendAudits(db);
  assert.deepEqual(audits.map((a) => [a.resource_type, a.result, a.office, a.prior_state]), [
    ['tc_referral.email_send_attempt', 'SUCCESS', 'roland', 'approved'],
    ['tc_referral.email_send', 'SUCCESS', 'roland', 'approved'],
  ]);
  assert.equal(audits[1].source_ref, 'acs_operation:op-77');
  for (const a of auditRows(db)) {
    assert.doesNotMatch(JSON.stringify(a), /endo\.example|Stedi|bitewing/i, 'no address, name or file name in the trail');
  }
  assert.equal(odReads, 0, 'zero Open Dental reads');

  // Sent is read-only for a second send.
  const again = await send(baseUrl, id);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'REFERRAL_TRANSITION_NOT_ALLOWED');
  assert.equal(posts(acsCalls).length, 1);
});

test('S: the hub and the detail read carry the specialist email and the history row', async (t) => {
  const { baseUrl, db } = await boot(t);
  const { id } = await approved(baseUrl, db);
  const hub = await apiJson(baseUrl, 'GET', REF('/hub'));
  const card = hub.body.referrals.find((r) => r.referralId === id);
  assert.equal(card.specialistEmail, 'Referrals@Endo.Example.test');
  assert.equal(card.sendProblem, null);
  assert.equal((await send(baseUrl, id)).status, 200);
  const detail = await apiJson(baseUrl, 'GET', REF(`/${id}`));
  assert.equal(detail.body.referral.events.at(-1).verb, 'send');
  assert.ok(contract.TcReferral.safeParse(detail.body.referral).success, 'the answer parses as the contract');
});

// ── O: honest ordering ──────────────────────────────────────────────────────

test('O: ACS refuses → 502, still approved, a visible send_failed row, claim released — and a retry sends', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id } = await approved(baseUrl, db);
  let refuse = true;
  acsClient.setFetchForTests(async (url, init) => {
    acsCalls.push({ method: init.method, url: String(url), body: JSON.parse(String(init.body || 'null')) });
    if (refuse) {
      return new Response(JSON.stringify({ error: { code: 'InvalidRecipient', message: 'no such mailbox referrals@endo.example.test' } }), { status: 400 });
    }
    return new Response(JSON.stringify({ id: 'op-2', status: 'Succeeded' }), { status: 202 });
  });

  const r = await send(baseUrl, id);
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'ACS_InvalidRecipient');
  assert.match(r.body.error, /refused the email \(InvalidRecipient\)/);
  assert.doesNotMatch(r.body.error, /endo\.example/, 'the provider sentence is scrubbed of addresses');
  assert.equal(referralRow(db, id).status, 'approved');
  assert.equal(referralRow(db, id).send_attempt_id, null);
  const failed = eventsOf(db, id).filter((e) => e.verb === 'send_failed');
  assert.equal(failed.length, 1);
  assert.deepEqual([failed[0].from_status, failed[0].to_status], ['approved', 'approved']);
  assert.match(failed[0].note, /^Not sent: The email service refused the email/);
  assert.equal(failed[0].acs_message_id ?? null, null);
  assert.equal(eventsOf(db, id).some((e) => e.verb === 'send'), false);
  assert.deepEqual(sendAudits(db).map((a) => [a.resource_type, a.result]), [
    ['tc_referral.email_send_attempt', 'SUCCESS'],
    ['tc_referral.email_send_failed', 'ERROR'],
  ]);

  const hub = await apiJson(baseUrl, 'GET', REF('/hub'));
  assert.equal(hub.body.referrals.find((x) => x.referralId === id).sendProblem.kind, 'failed');

  refuse = false;
  const retry = await send(baseUrl, id);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.referral.status, 'sent');
  assert.equal(retry.body.referral.sendProblem, null);
});

test('O: a failure that raced a move is recorded on the status it moved to, not on approved', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id } = await approved(baseUrl, db);
  acsClient.setFetchForTests(async (url, init) => {
    acsCalls.push({ method: init.method, url: String(url) });
    referralRow(db, id).status = 'pending_signoff'; // a reopen landed meanwhile
    return new Response(JSON.stringify({ error: { code: 'Busy', message: 'try later' } }), { status: 503 });
  });
  const r = await send(baseUrl, id);
  assert.equal(r.status, 502);
  const failed = eventsOf(db, id).filter((e) => e.verb === 'send_failed');
  assert.equal(failed.length, 1);
  assert.deepEqual([failed[0].from_status, failed[0].to_status], ['pending_signoff', 'pending_signoff']);
  assert.equal(sendAudits(db).at(-1).prior_state, 'pending_signoff');
  assert.equal(referralRow(db, id).send_attempt_id, null);
});

test('O: ACS accepts then reports Failed → nothing moves; a timeout → nothing moves', async (t) => {
  const { baseUrl, db } = await boot(t, { acsStatus: 'Running', acsPolls: [{ status: 'Failed', error: { code: 'Bounced' } }] });
  const { id } = await approved(baseUrl, db);
  const r = await send(baseUrl, id);
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'ACS_Bounced');
  assert.equal(referralRow(db, id).status, 'approved');

  acsClient.setFetchForTests(async () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    throw err;
  });
  const t2 = await send(baseUrl, id);
  assert.equal(t2.status, 502);
  assert.equal(t2.body.code, 'ACS_TIMEOUT');
  assert.equal(referralRow(db, id).status, 'approved');
  assert.equal(eventsOf(db, id).filter((e) => e.verb === 'send_failed').length, 2);
});

test('O: ACS accepted but its status read failed → it IS out (queued): approved → sent', async (t) => {
  const { baseUrl, db } = await boot(t, { acsStatus: 'Running', acsPolls: [new Error('status read down')] });
  const { id } = await approved(baseUrl, db);
  const r = await send(baseUrl, id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.referral.status, 'sent');
});

test('O: the attempt audit fails → 500 AUDIT_FAILED and nothing is sent', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id } = await approved(baseUrl, db);
  failAuditFor(db, 'tc_referral.email_send_attempt');
  const r = await send(baseUrl, id);
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 'AUDIT_FAILED');
  assert.equal(acsCalls.length, 0);
  assert.equal(referralRow(db, id).status, 'approved');
  assert.equal(referralRow(db, id).send_attempt_id ?? null, null, 'no claim was taken');
});

// ── C: conflicts ────────────────────────────────────────────────────────────

test('C: the in-transaction audit fails → the move rolls back; the email is out, recorded as send_conflict, never re-sent', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id } = await approved(baseUrl, db);
  realTransactions(db);
  failAuditFor(db, 'tc_referral.email_send');

  const r = await send(baseUrl, id);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'REFERRAL_EMAIL_CONFLICT');
  assert.match(r.body.error, /The email went out .* the audit record could not be written/);
  assert.equal(posts(acsCalls).length, 1);
  assert.equal(referralRow(db, id).status, 'approved', 'the move rolled back');
  assert.equal(referralRow(db, id).send_attempt_id, null);
  assert.equal(eventsOf(db, id).some((e) => e.verb === 'send'), false, 'its event rolled back with it');
  const conflict = eventsOf(db, id).find((e) => e.verb === 'send_conflict');
  assert.equal(conflict.acs_message_id, 'op-1');
  assert.equal(conflict.recipient_address, SPECIALIST);
  assert.match(conflict.unsubscribe_token_hash, /^[0-9a-f]{64}$/);
  assert.equal(r.body.referral.sendProblem.kind, 'conflict');

  // It will not be emailed twice.
  const again = await send(baseUrl, id);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'REFERRAL_ALREADY_EMAILED');
  assert.equal(posts(acsCalls).length, 1);
  // A person can still record it.
  const mark = await apiJson(baseUrl, 'POST', REF(`/${id}/mark-sent`), { how: 'Confirmed by phone it arrived by email' });
  assert.equal(mark.status, 200);
});

test('C: the referral moved while the email was out → send_conflict on its new status, a 409 that says it went', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id } = await approved(baseUrl, db);
  acsClient.setFetchForTests(async (url, init) => {
    acsCalls.push({ method: init.method, url: String(url) });
    referralRow(db, id).status = 'pending_signoff'; // a reopen landed meanwhile
    return new Response(JSON.stringify({ id: 'op-9', status: 'Succeeded' }), { status: 202 });
  });
  const r = await send(baseUrl, id);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'REFERRAL_EMAIL_CONFLICT');
  assert.match(r.body.error, /changed while the email was going out/);
  const conflict = eventsOf(db, id).find((e) => e.verb === 'send_conflict');
  assert.deepEqual([conflict.from_status, conflict.to_status, conflict.acs_message_id], ['pending_signoff', 'pending_signoff', 'op-9']);
  assert.equal(referralRow(db, id).send_attempt_id, null);
  assert.deepEqual(sendAudits(db).map((a) => a.resource_type).slice(-1), ['tc_referral.email_send_conflict']);
});

// ── G: gates ────────────────────────────────────────────────────────────────

test('G: no email on file → 409 with the exact copy; no claim, no event (a click before the claim)', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id } = await approved(baseUrl, db, { entry: seedEntry(db, { email: '' }) });
  const hub = await apiJson(baseUrl, 'GET', REF('/hub'));
  assert.equal(hub.body.referrals.find((x) => x.referralId === id).specialistEmail, null);
  const r = await send(baseUrl, id);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'No email on file — add it in Settings → Referrals, or mark sent outside the app.');
  assert.equal(acsCalls.length, 0);
  assert.equal(eventsOf(db, id).some((e) => String(e.verb).startsWith('send')), false);
});

test('G: an inactive specialist, or none chosen, is refused', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const entry = seedEntry(db);
  const { id } = await approved(baseUrl, db, { entry });
  entry.active = false;
  const r = await send(baseUrl, id);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /inactive/);
  referralRow(db, id).directory_entry_id = null;
  assert.match((await send(baseUrl, id)).body.error, /Choose a specialist/);
  assert.equal(acsCalls.length, 0);
});

test('G: per-office sender ONLY — the shared ACS_EMAIL_FROM never sends a referral; a reply-to is required', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id } = await approved(baseUrl, db);
  process.env.ACS_EMAIL_FROM_ROLAND = '';
  process.env.ACS_EMAIL_FROM = 'shared@deployment.example.test';
  assert.equal(acsConfig.fromAddressFor('roland'), 'shared@deployment.example.test', 'patient email would fall back');
  const r = await send(baseUrl, id);
  assert.equal(r.status, 501);
  assert.equal(r.body.code, 'FEATURE_DISABLED');
  assert.equal(r.body.reason, 'office_not_configured');
  assert.ok(r.body.missing.includes('ACS_EMAIL_FROM_ROLAND'));
  const s = await apiJson(baseUrl, 'GET', REF('/status'));
  assert.deepEqual(s.body.emailSend, { enabled: true, unavailable: 'office_not_configured' });

  process.env.ACS_EMAIL_FROM_ROLAND = 'donotreply@roland.example.test';
  delete process.env.ACS_EMAIL_REPLY_TO_ROLAND;
  const noReply = await send(baseUrl, id);
  assert.equal(noReply.status, 501);
  assert.ok(noReply.body.missing.includes('ACS_EMAIL_REPLY_TO_ROLAND'));
  assert.equal(acsCalls.length, 0);
});

test("G: the transport's own gates stand — its kill switch, and no unsubscribe config → no send", async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id } = await approved(baseUrl, db);
  process.env.TC_EMAIL_ENABLED = 'false';
  const off = await send(baseUrl, id);
  assert.equal(off.status, 501);
  assert.equal(off.body.reason, 'switched_off');
  process.env.TC_EMAIL_ENABLED = 'true';
  delete process.env.TC_EMAIL_PUBLIC_BASE_URL;
  const noLink = await send(baseUrl, id);
  assert.equal(noLink.status, 501);
  assert.equal(noLink.body.reason, 'not_configured');
  assert.ok(noLink.body.missing.includes('TC_EMAIL_PUBLIC_BASE_URL'));
  assert.equal(acsCalls.length, 0);
  assert.equal(referralRow(db, id).status, 'approved');
});

test("G: an address that unsubscribed is refused (consent rule 1), with no Open Dental read", async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id } = await approved(baseUrl, db);
  db.table('tc_contact_consent').push({ consent_id: randomUUID(), office_id: 'roland', channel: 'email', address: SPECIALIST, state: 'opted_out' });
  const r = await send(baseUrl, id);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'CONSENT_OPTED_OUT');
  assert.equal(acsCalls.length, 0);
  assert.equal(odReads, 0);
});

test('G: a live claim refuses a second send; a stale one is taken over', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id } = await approved(baseUrl, db);
  const row = referralRow(db, id);
  row.send_attempt_id = randomUUID();
  row.send_attempt_at = new Date(NOW.getTime() - 60_000).toISOString();
  const busy = await send(baseUrl, id);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, 'REFERRAL_SEND_IN_PROGRESS');
  assert.equal(acsCalls.length, 0);
  row.send_attempt_at = new Date(NOW.getTime() - referralSend.CLAIM_STALE_MS - 1000).toISOString();
  const r = await send(baseUrl, id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(posts(acsCalls).length, 1);
});

test('G: strict body — a smuggled recipient, office or subject is a 400 and nothing is sent', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id } = await approved(baseUrl, db);
  for (const body of [{ to: 'attacker@example.test' }, { office: 'valley' }, { subject: 'x' }, { attachments: [] }]) {
    const r = await send(baseUrl, id, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await apiJson(baseUrl, 'POST', REF('/not-a-uuid/send-email'), {})).status, 400);
  assert.equal(acsCalls.length, 0);
});

test("G: office comes from the server — another office's referral is not found", async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t, { env: { TC_REFERRALS_ENABLED_VALLEY: 'true', TC_REFERRAL_EMAIL_ENABLED_VALLEY: 'true' } });
  const { id } = await approved(baseUrl, db);
  const r = await send(baseUrl, id, {}, 'valley');
  assert.equal(r.status, 404);
  assert.equal(acsCalls.length, 0);
  assert.equal(referralRow(db, id).status, 'approved');
});

test('G: only approved can be emailed', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const c = seedCase(db);
  const entry = seedEntry(db);
  const created = await apiJson(baseUrl, 'POST', REF(), { source: { caseId: c.case_id }, referral: { ...INPUT, directoryEntryId: entry.entry_id } });
  const r = await send(baseUrl, created.body.referral.referralId);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'REFERRAL_TRANSITION_NOT_ALLOWED');
  assert.equal(acsCalls.length, 0);
});

// ── P: packing ──────────────────────────────────────────────────────────────

test('P: files go as a PREFIX in upload order under the budget; the rest are listed, never dropped', async (t) => {
  const files = new Map();
  const { baseUrl, db, acsCalls } = await boot(t, { files });
  const { id } = await approved(baseUrl, db);
  const MB = 1024 * 1024;
  // 3 MB + 3 MB fit (≈8.4 MB of base64 + letter); the third, though small, comes after one that would not.
  seedFile(db, files, id, { name: 'a.png', bytes: Buffer.alloc(3 * MB, 1), order: 1 });
  seedFile(db, files, id, { name: 'b.png', bytes: Buffer.alloc(3 * MB, 2), order: 2 });
  seedFile(db, files, id, { name: 'c.png', bytes: Buffer.alloc(1 * MB, 3), order: 3 });
  const r = await send(baseUrl, id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = posts(acsCalls)[0];
  assert.deepEqual(p.body.attachments.map((a) => a.name), ['a.png', 'b.png']);
  assert.match(p.body.content.plainText, /Attached: a\.png, b\.png\nAdditional images available on request: c\.png/);
  assert.match(eventsOf(db, id).find((e) => e.verb === 'send').note, /2 files attached; 1 listed as available on request/);
  const bytes = Buffer.byteLength(JSON.stringify(p.body), 'utf8');
  assert.ok(bytes <= referralSend.PACKING_BUDGET_BYTES, `${bytes} within the budget`);
  assert.ok(referralSend.PACKING_BUDGET_BYTES < acsConfig.ACS_MAX_REQUEST_BYTES);
});

test('P: upload order is kept — a big second file stops the prefix even though the third would fit', async (t) => {
  const files = new Map();
  const { baseUrl, db, acsCalls } = await boot(t, { files });
  const { id } = await approved(baseUrl, db);
  const MB = 1024 * 1024;
  seedFile(db, files, id, { name: 'first.png', bytes: Buffer.alloc(1 * MB, 1), order: 1 });
  seedFile(db, files, id, { name: 'huge.pdf', ext: 'pdf', bytes: Buffer.alloc(7 * MB, 2), order: 2 });
  seedFile(db, files, id, { name: 'tiny.png', bytes: Buffer.alloc(10, 3), order: 3 });
  assert.equal((await send(baseUrl, id)).status, 200);
  const p = posts(acsCalls)[0].body;
  assert.deepEqual(p.attachments.map((a) => a.name), ['first.png']);
  assert.match(p.content.plainText, /Additional images available on request: huge\.pdf, tiny\.png/);
});

test('P: a file that cannot be read stops the send — nothing goes out with a file silently missing', async (t) => {
  const files = new Map();
  const { baseUrl, db, acsCalls } = await boot(t, { files });
  const { id } = await approved(baseUrl, db);
  const key = seedFile(db, files, id, { name: 'gone.png', bytes: Buffer.from('x'), order: 1 });
  files.delete(key);
  const r = await send(baseUrl, id);
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'ATTACHMENT_READ_FAILED');
  assert.equal(acsCalls.length, 0);
  assert.equal(referralRow(db, id).send_attempt_id, null, 'claim released');
  assert.match(eventsOf(db, id).find((e) => e.verb === 'send_failed').note, /could not be read/);
});

// ── A: auto-send on approval ────────────────────────────────────────────────

async function pendingWithAutosend(baseUrl, db, entry = seedEntry(db)) {
  db.table('tc_referral_settings').push({ office_id: 'roland', signoff_required: true, autosend_on_approval: true, updated_by: 'boss@carein.ai' });
  const c = seedCase(db);
  const created = await apiJson(baseUrl, 'POST', REF(), { source: { caseId: c.case_id }, referral: { ...INPUT, directoryEntryId: entry.entry_id } });
  const id = created.body.referral.referralId;
  assert.equal((await apiJson(baseUrl, 'POST', REF(`/${id}/submit`), {})).status, 200);
  return id;
}

test('A: approval with auto-send ON emails it and answers sent; the approval and the send are two history rows', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const id = await pendingWithAutosend(baseUrl, db);
  const a = await apiJson(baseUrl, 'POST', SIGN(`/${id}/approve`), {});
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.autoSend.status, 'sent');
  assert.equal(a.body.referral.status, 'sent');
  assert.equal(posts(acsCalls).length, 1);
  assert.deepEqual(eventsOf(db, id).slice(-2).map((e) => [e.verb, e.from_status, e.to_status]), [
    ['approve', 'pending_signoff', 'approved'],
    ['send', 'approved', 'sent'],
  ]);
  assert.match(eventsOf(db, id).at(-1).note, /automatically on approval/);
});

test('A: a failed auto-send never fails the approval — approved, a visible send_failed row, and a retry that works', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const id = await pendingWithAutosend(baseUrl, db);
  let down = true;
  acsClient.setFetchForTests(async (url, init) => {
    acsCalls.push({ method: init.method, url: String(url) });
    if (down) return new Response(JSON.stringify({ error: { code: 'ServiceUnavailable', message: 'busy' } }), { status: 503 });
    return new Response(JSON.stringify({ id: 'op-3', status: 'Succeeded' }), { status: 202 });
  });
  const a = await apiJson(baseUrl, 'POST', SIGN(`/${id}/approve`), {});
  assert.equal(a.status, 200, 'the approval succeeded');
  assert.equal(a.body.success, true);
  assert.equal(a.body.referral.status, 'approved');
  assert.equal(a.body.autoSend.status, 'failed');
  assert.match(a.body.autoSend.message, /ServiceUnavailable/);
  assert.match(eventsOf(db, id).at(-1).note, /^Not sent automatically: /);
  assert.equal(a.body.referral.sendProblem.kind, 'failed');
  down = false;
  const retry = await send(baseUrl, id);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.referral.status, 'sent');
});

test('A: an auto-send stopped by a gate is still recorded (no email on file) — and the approval stands', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const id = await pendingWithAutosend(baseUrl, db, seedEntry(db, { email: '' }));
  const a = await apiJson(baseUrl, 'POST', SIGN(`/${id}/approve`), {});
  assert.equal(a.status, 200);
  assert.equal(a.body.autoSend.status, 'failed');
  assert.equal(a.body.referral.status, 'approved');
  assert.match(eventsOf(db, id).at(-1).note, /^Not sent automatically: No email on file/);
  assert.equal(acsCalls.length, 0);
});

test('A: auto-send OFF, or email OFF → approval answers as before, no autoSend key, nothing sent', async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const c = seedCase(db);
  const entry = seedEntry(db);
  const created = await apiJson(baseUrl, 'POST', REF(), { source: { caseId: c.case_id }, referral: { ...INPUT, directoryEntryId: entry.entry_id } });
  const id = created.body.referral.referralId;
  await apiJson(baseUrl, 'POST', REF(`/${id}/submit`), {});
  const a = await apiJson(baseUrl, 'POST', SIGN(`/${id}/approve`), {});
  assert.equal(a.status, 200);
  assert.equal('autoSend' in a.body, false);
  assert.equal(acsCalls.length, 0);
});

test('A: the unsafe pair (sign-off OFF + auto-send ON) is still refused', async (t) => {
  const { baseUrl } = await boot(t);
  const r = await apiJson(baseUrl, 'PUT', REF('/settings'), { signoffRequired: false, autosendOnApproval: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'REFERRAL_POLICY_UNSAFE');
});

// ── U: the unsubscribe link ─────────────────────────────────────────────────

test("U: the referral email's unsubscribe link opts the SPECIALIST's address out; the next send is refused", async (t) => {
  const { baseUrl, db, acsCalls } = await boot(t);
  const { id } = await approved(baseUrl, db);
  assert.equal((await send(baseUrl, id)).status, 200);
  const link = posts(acsCalls)[0].body.headers['List-Unsubscribe'].slice(1, -1);
  const token = new URL(link).searchParams.get('t');
  const res = await fetch(`${baseUrl}/api/webhooks/email/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `t=${encodeURIComponent(token)}`,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    db.table('tc_contact_consent').map((r) => [r.office_id, r.channel, r.address, r.state, r.source]),
    [['roland', 'email', SPECIALIST, 'opted_out', 'unsubscribe_link']]
  );
  assert.ok(auditRows(db).some((a) => a.resource_type === 'tc_referral_event.unsubscribe_link'));

  const second = await approved(baseUrl, db, { entry: seedEntry(db) });
  const refused = await send(baseUrl, second.id);
  assert.equal(refused.body.code, 'CONSENT_OPTED_OUT');
  assert.equal(posts(acsCalls).length, 1);
});

// ── L: the letter's words ───────────────────────────────────────────────────

test('L: names, teeth, short reasons and the subject', () => {
  assert.deepEqual(letterText.nameParts('Test 2, Stedi'), { first: 'Stedi', last: 'Test 2', full: 'Stedi Test 2' });
  assert.deepEqual(letterText.nameParts('MangoTest Test'), { first: 'MangoTest', last: 'Test', full: 'MangoTest Test' });
  assert.equal(letterText.specialistLastName('Dr. Endo Example, DDS, MS'), 'Example');
  assert.equal(letterText.specialistLastName(''), '');
  assert.equal(letterText.teethText('mouth'), 'Full mouth');
  assert.equal(letterText.teethText([3, 14]), '#3, #14');
  assert.equal(letterText.teethText([]), 'Not specified');
  const long = 'Evaluate for extraction of the lower left third molar and possible bone graft in the same visit';
  assert.ok(letterText.shortReason(long).length <= 61);
  assert.match(letterText.shortReason(long), /…$/);
  const out = letterText.composeReferralLetter({
    referral: { patient_name: 'Test 2, Stedi', reason: 'TMJ pain', teeth: 'mouth', urgency: 'urgent', doctor_note: null, referring_provider: 'Dr. Smith', narrative: '' },
    entry: { specialist_name: '' },
    office: { name: 'Roland Family Dental', address: null, phone: null, replyTo: 'front@roland.example.test' },
    attached: [],
    onRequest: [],
    at: NOW,
    timeZone: 'America/Chicago',
  });
  assert.equal(out.subject, 'Referral from Roland Family Dental — Stedi T., TMJ pain');
  assert.match(out.text, /^Dear Doctor,/);
  assert.match(out.text, /We are referring Stedi for TMJ pain\./, 'an acronym keeps its capitals');
  assert.match(out.text, /Clinical summary:\nNone provided\./);
  assert.match(out.text, /No attachments\./);
  assert.match(out.text, /Sincerely,\nDr\. Smith\nRoland Family Dental\nReply to: /);
  assert.doesNotMatch(out.text, /Doctor's note/, 'only when there is one');
});

// ── guards ──────────────────────────────────────────────────────────────────

test('guards: the send path reaches ACS only through the email adapter, and never Open Dental', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
  for (const rel of ['routes/tc/referralSend.js', 'routes/tc/referralLetterText.js', 'services/messaging/referralLetter.js']) {
    const src = read(rel);
    assert.doesNotMatch(src, /getOdOffice|apiGetRaw|apiPost|apiPut|apiPatch|apiDelete|odPatientCache|openDental/, rel);
    assert.doesNotMatch(src, /acs\/client|@azure\/communication-email|\bsendEmail\(/, `${rel}: no second path to ACS`);
    assert.doesNotMatch(src, /setTimeout|setInterval|cron/, `${rel}: nothing scheduled`);
    const logs = src.match(/console\.(log|warn|error)\([\s\S]*?\);/g) || [];
    for (const line of logs) assert.doesNotMatch(line, /recipient|address|subject|text|patient|file_name|name\b/i, `${rel}: ${line}`);
  }
  // The only routes that can email a referral are the send route and the approval.
  const routes = ['routes/tc/referrals.js', 'routes/tc/referralSignoff.js'];
  assert.match(read(routes[0]), /referralSend\.sendReferral\(req, \{ office: req\.tcOffice, referralId: id\.data, trigger: 'manual' \}\)/);
  assert.match(read(routes[1]), /referralSend\.sendAfterApproval\(req, \{ office: req\.tcOffice, referralId: id\.data \}\)/);
});
