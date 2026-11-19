'use strict';

/**
 * Referral hub manual moves + draft delete (referral-manual-moves).
 *
 *   M1  the route × status matrix: every TC-side route moves exactly where the
 *       shared table says, and 409s everywhere else — on the assembled app
 *   M2  the sign-off bypass is structural: no tc.full route takes
 *       pending_signoff to approved or sent, and there is no TC-side approve
 *   M3  cancel from approved / sent / acknowledged / patient_seen: one event
 *       (actor + note), one audit row, the link tokens gone; refused 409 while
 *       an email is in flight; a stale claim does not block
 *   M4  CAS: a stale card is refused naming where it stands now
 *   D1  a never-sent draft deletes: row + history + attachment rows + tokens,
 *       its files deleted after commit, one DELETE audit row (prior: draft)
 *   D2  every non-draft status is 409 on the assembled DELETE route; a draft
 *       with outside-the-app history is 409; an approve in history is not
 *   D3  a failed audit write rolls the delete back; storage failures are
 *       counted, never hidden
 *   P   a doctor (sign-off only) and hygiene cannot move or delete
 *
 * Test patients only (roland 12827); names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const transitions = require('./referralTransitions');
const store = require('./referralStore');
const blob = require('../../services/tc/referralAttachmentStore');
const { contract } = require('./helpers');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const NOW = new Date('2026-11-18T15:00:00.000Z');
const STATUSES = contract.TcReferralStatus.options;

function switchReferrals(t) {
  const orig = registry.getPlatformSetting;
  const keep = { a: process.env.REFERRAL_SIGNOFF_REQUIRED_ROLAND, b: process.env.TC_REFERRALS_ENABLED_ROLAND };
  delete process.env.REFERRAL_SIGNOFF_REQUIRED_ROLAND;
  delete process.env.TC_REFERRALS_ENABLED_ROLAND;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_referrals_enabled' ? { key, value: { roland: true }, updated_at: new Date(), updated_by: null } : null;
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

/** Record blob deletes; `fail` keys throw. */
function stubBlob(t, { fail = [] } = {}) {
  const saved = { isConfigured: blob.isConfigured, deleteAttachment: blob.deleteAttachment };
  const deleted = [];
  blob.isConfigured = () => true;
  blob.deleteAttachment = async (key) => {
    if (fail.includes(key)) throw new Error('storage down');
    deleted.push(key);
    return true;
  };
  t.after(() => Object.assign(blob, saved));
  return deleted;
}

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

const REF = (path = '', office = 'roland') => `/api/tc/referrals${path}?office=${office}`;
const SIGN = (path = '', office = 'roland') => `/api/tc/referrals/signoff${path}?office=${office}`;

function seedCase(db) {
  const row = { case_id: randomUUID(), office_id: 'roland', patient_name: 'Test 2, Stedi', od_patient_id: 12827, status: 'pending_tc' };
  db.table('tc_cases').push(row);
  return row;
}

/** A draft made through the real create route; returns its stored row. */
async function draft(baseUrl, db) {
  const r = await api(baseUrl, 'POST', REF(), {
    source: { caseId: seedCase(db).case_id },
    referral: { reason: 'Possible cracked tooth, needs endo eval', urgency: 'soon', teeth: [3] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return db.table('tc_referrals').find((x) => x.referral_id === r.body.referral.referralId);
}

function event(db, row, verb, extra = {}) {
  db.table('tc_referral_events').push({
    event_id: randomUUID(),
    office_id: 'roland',
    referral_id: row.referral_id,
    from_status: row.status,
    to_status: row.status,
    actor: 'tc@carein.ai',
    at: NOW,
    note: '',
    verb,
    ...extra,
  });
}

function token(db, referralId) {
  const row = {
    token_hash: randomUUID().replace(/-/g, ''),
    office_id: 'roland',
    referral_id: referralId,
    audience: 'specialist',
    purpose: 'received',
    created_at: NOW,
    expires_at: new Date(NOW.getTime() + 864e5),
    used_at: null,
  };
  db.table('tc_referral_link_tokens').push(row);
  return row;
}

function attachment(db, referralId) {
  const row = {
    attachment_id: randomUUID(),
    office_id: 'roland',
    referral_id: referralId,
    file_name: 'xray.png',
    content_type: 'image/png',
    size_bytes: 10,
    blob_key: `carein/referrals/${randomUUID()}.png`,
    uploaded_by: 'tc@carein.ai',
  };
  db.table('tc_referral_attachments').push(row);
  return row;
}

/** Make the fake roll back on ROLLBACK, as Postgres does. */
function realTransactions(db) {
  let snapshot = null;
  db.onQuery(/^BEGIN$/, () => {
    snapshot = new Map([...db.tables].map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
    return { rows: [], rowCount: 0 };
  });
  db.onQuery(/^ROLLBACK$/, () => {
    for (const [k, rows] of snapshot || []) {
      const live = db.table(k);
      live.length = 0;
      live.push(...rows);
    }
    return { rows: [], rowCount: 0 };
  });
}

/** Every TC-side (tc.full) move route: path, verb, body. */
const TC_ROUTES = [
  ['submit', 'submit', {}],
  ['withdraw', 'withdraw', {}],
  ['cancel', 'cancel', {}],
  ['reopen', 'reopen', {}],
  ['mark-sent', 'mark_sent', { how: 'Faxed to their front desk' }],
  ['mark-acknowledged', 'mark_acknowledged', {}],
  ['mark-patient-seen', 'mark_patient_seen', {}],
  ['close', 'close', {}],
];

// ── M1 + M2: the matrix ─────────────────────────────────────────────────────

test('M1: every TC route × every status moves exactly where the shared table says, and 409s everywhere else', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const row = await draft(baseUrl, db);
  const expectedSelf = {
    submit: { draft: 'pending_signoff' },
    withdraw: { pending_signoff: 'draft' },
    cancel: Object.fromEntries(['draft', 'pending_signoff', 'approved', 'sent', 'acknowledged', 'patient_seen'].map((s) => [s, 'cancelled'])),
    reopen: { approved: 'pending_signoff' },
    mark_sent: { approved: 'sent' },
    mark_acknowledged: { sent: 'acknowledged' },
    mark_patient_seen: { acknowledged: 'patient_seen' },
    close: { patient_seen: 'closed' },
  };
  for (const [path, verb, body] of TC_ROUTES) {
    for (const from of STATUSES) {
      row.status = from;
      const before = db.table('tc_referral_events').length;
      const r = await api(baseUrl, 'POST', REF(`/${row.referral_id}/${path}`), body);
      const want = expectedSelf[verb][from] ?? null;
      // The pinned list agrees with the shared table (sign-off required, the default).
      assert.equal(contract.referralNextStatus(from, verb, { signoffRequired: true }), want, `table ${verb} from ${from}`);
      if (want) {
        assert.equal(r.status, 200, `${path} from ${from}: ${JSON.stringify(r.body)}`);
        assert.equal(row.status, want, `${path} from ${from}`);
        assert.equal(db.table('tc_referral_events').length, before + 1, `${path} from ${from}: one event`);
      } else {
        assert.deepEqual([r.status, r.body.code, r.body.currentStatus], [409, 'REFERRAL_TRANSITION_NOT_ALLOWED', from], `${path} from ${from}`);
        assert.equal(row.status, from, `${path} from ${from}: nothing moved`);
        assert.equal(db.table('tc_referral_events').length, before, `${path} from ${from}: no event`);
      }
    }
  }
});

test('M2: the sign-off bypass is structural — no tc.full route takes pending_signoff to approved or sent', async (t) => {
  switchReferrals(t);
  // admin holds BOTH tc.full and sign-off: even so, the TC routes cannot approve.
  const { baseUrl, db } = await boot(t);
  const row = await draft(baseUrl, db);
  for (const [path, , body] of TC_ROUTES) {
    row.status = 'pending_signoff';
    await api(baseUrl, 'POST', REF(`/${row.referral_id}/${path}`), body);
    assert.ok(!['approved', 'sent'].includes(row.status), `${path} took pending_signoff to ${row.status}`);
  }
  // There is no TC-side approve / send / generic move to name a target with.
  row.status = 'pending_signoff';
  for (const path of ['approve', 'move', 'status', 'send', 'mark-approved']) {
    const r = await api(baseUrl, 'POST', REF(`/${row.referral_id}/${path}`), { to: 'approved' });
    assert.equal(r.status, 404, `POST /${path} exists`);
  }
  assert.equal(row.status, 'pending_signoff');
  // A note body cannot carry a target either: strict.
  const r = await api(baseUrl, 'POST', REF(`/${row.referral_id}/withdraw`), { note: 'x', to: 'approved' });
  assert.equal(r.status, 400);
  assert.equal(row.status, 'pending_signoff');
  // And a TC (not a signer) is refused at the sign-off routes.
  const tc = await boot(t, { role: 'tc', db });
  assert.equal((await api(tc.baseUrl, 'POST', SIGN(`/${row.referral_id}/approve`))).status, 403);
  assert.equal(row.status, 'pending_signoff');
});

// ── M3: cancel after send ───────────────────────────────────────────────────

test('M3: cancel from sent writes one event with actor + note, one audit row, and drops ONLY its link tokens', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t, { role: 'tc', user: { email: 'tc@carein.ai', name: 'TC', tenantId: 'x' } });
  const row = await draft(baseUrl, db);
  const other = await draft(baseUrl, db);
  row.status = 'sent';
  token(db, row.referral_id);
  token(db, row.referral_id);
  const keep = token(db, other.referral_id);
  const auditsBefore = auditRows(db).length;

  const r = await api(baseUrl, 'POST', REF(`/${row.referral_id}/cancel`), { note: 'Patient went elsewhere' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.referral.status, 'cancelled');
  const last = r.body.referral.events.at(-1);
  assert.deepEqual([last.verb, last.fromStatus, last.toStatus, last.actor, last.note], ['cancel', 'sent', 'cancelled', 'tc@carein.ai', 'Patient went elsewhere']);
  const audits = auditRows(db).slice(auditsBefore).filter((a) => a.resource_type === 'tc_referral');
  assert.deepEqual(
    audits.map((a) => [a.action, a.resource_id, a.prior_state]),
    [['UPDATE', row.referral_id, 'sent']]
  );
  assert.deepEqual(db.table('tc_referral_link_tokens').map((x) => x.token_hash), [keep.token_hash]);
});

test('M3: cancel is refused 409 while an email is in flight; a stale claim is cleared and does not block', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const row = await draft(baseUrl, db);
  row.status = 'approved';
  row.send_attempt_id = randomUUID();
  row.send_attempt_at = new Date(NOW.getTime() - 30_000).toISOString();
  token(db, row.referral_id);

  let r = await api(baseUrl, 'POST', REF(`/${row.referral_id}/cancel`));
  assert.deepEqual([r.status, r.body.code, r.body.currentStatus], [409, 'REFERRAL_SEND_IN_PROGRESS', 'approved']);
  assert.equal(row.status, 'approved');
  assert.equal(db.table('tc_referral_link_tokens').length, 1, 'tokens untouched');

  row.send_attempt_at = new Date(NOW.getTime() - 10 * 60_000).toISOString();
  r = await api(baseUrl, 'POST', REF(`/${row.referral_id}/cancel`));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(row.status, 'cancelled');
  assert.equal(row.send_attempt_id, null, 'the stale claim was released');
  assert.equal(db.table('tc_referral_link_tokens').length, 0);
});

test('M3: a send that claims between the read and the move makes cancel lose, not both win', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const row = await draft(baseUrl, db);
  row.status = 'approved';
  db.onQuery(/^SELECT referral_id, status, send_attempt_id, send_attempt_at FROM tc_referrals/, () => {
    const snap = { ...row };
    // The send claims right after this read.
    row.send_attempt_id = randomUUID();
    row.send_attempt_at = NOW.toISOString();
    return { rows: [{ referral_id: snap.referral_id, status: snap.status, send_attempt_id: null, send_attempt_at: null }] };
  });
  const r = await api(baseUrl, 'POST', REF(`/${row.referral_id}/cancel`));
  assert.deepEqual([r.status, r.body.code], [409, 'REFERRAL_SEND_IN_PROGRESS']);
  assert.equal(row.status, 'approved');
});

test('M3: the stale-claim window mirrors referralSend.js exactly', () => {
  assert.equal(store.SEND_CLAIM_STALE_MS, require('./referralSend').CLAIM_STALE_MS);
});

// ── M4: CAS ─────────────────────────────────────────────────────────────────

test('M4: a stale card is refused naming where the referral stands now; nothing is written', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const row = await draft(baseUrl, db);
  row.status = 'sent';
  // Someone else moves it between this request's read and its write.
  db.onQuery(/^UPDATE tc_referrals SET status = /, () => {
    row.status = 'closed';
    return { rows: [], rowCount: 0 };
  });
  const events = db.table('tc_referral_events').length;
  for (const [path, body] of [['mark-acknowledged', {}], ['cancel', {}]]) {
    row.status = 'sent';
    const r = await api(baseUrl, 'POST', REF(`/${row.referral_id}/${path}`), body);
    assert.deepEqual([r.status, r.body.code, r.body.currentStatus], [409, 'REFERRAL_TRANSITION_NOT_ALLOWED', 'closed'], path);
  }
  assert.equal(db.table('tc_referral_events').length, events);
});

// ── D: draft delete ─────────────────────────────────────────────────────────

test('D1: a never-sent draft deletes — row, history, attachment rows, tokens — files after commit, one DELETE audit row', async (t) => {
  switchReferrals(t);
  const deleted = stubBlob(t);
  const { baseUrl, db } = await boot(t, { role: 'tc', user: { email: 'tc@carein.ai', name: 'TC', tenantId: 'x' } });
  const row = await draft(baseUrl, db);
  const keep = await draft(baseUrl, db);
  const files = [attachment(db, row.referral_id), attachment(db, row.referral_id)];
  const keepFile = attachment(db, keep.referral_id);
  token(db, row.referral_id);
  // Submitted, approved, reopened, sent back: an approve in history does NOT block.
  for (const verb of ['submit', 'approve', 'reopen', 'return']) event(db, row, verb);
  const auditsBefore = auditRows(db).length;

  const r = await api(baseUrl, 'DELETE', REF(`/${row.referral_id}`));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { success: true, referralId: row.referral_id, filesRemoved: 2, filesLeft: 0 });
  const id = row.referral_id;
  assert.equal(db.table('tc_referrals').some((x) => x.referral_id === id), false);
  for (const tbl of ['tc_referral_events', 'tc_referral_attachments', 'tc_referral_link_tokens']) {
    assert.equal(db.table(tbl).some((x) => x.referral_id === id), false, tbl);
  }
  assert.deepEqual(deleted.sort(), files.map((f) => f.blob_key).sort());
  // The other referral is untouched.
  assert.ok(db.table('tc_referrals').some((x) => x.referral_id === keep.referral_id));
  assert.ok(db.table('tc_referral_attachments').some((x) => x.attachment_id === keepFile.attachment_id));
  const audits = auditRows(db).slice(auditsBefore);
  assert.deepEqual(
    audits.map((a) => [a.action, a.resource_type, a.resource_id, a.prior_state, a.user_id]),
    [['DELETE', 'tc_referral', id, 'draft', 'tc@carein.ai']]
  );
  // Gone is gone.
  assert.equal((await api(baseUrl, 'DELETE', REF(`/${id}`))).status, 404);
  assert.equal((await api(baseUrl, 'GET', REF(`/${id}`))).status, 404);
});

test('D2: every non-draft status is 409 on the assembled DELETE route — nothing deleted, no file touched', async (t) => {
  switchReferrals(t);
  const deleted = stubBlob(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const row = await draft(baseUrl, db);
  attachment(db, row.referral_id);
  for (const status of STATUSES.filter((s) => s !== 'draft')) {
    row.status = status;
    const r = await api(baseUrl, 'DELETE', REF(`/${row.referral_id}`));
    assert.deepEqual([r.status, r.body.code, r.body.currentStatus], [409, 'REFERRAL_DELETE_NOT_DRAFT', status], status);
  }
  assert.equal(db.table('tc_referrals').length, 1);
  assert.equal(db.table('tc_referral_attachments').length, 1);
  assert.deepEqual(deleted, []);
});

test('D2: a draft with any outside-the-app history is kept (409) — chart_note_written above all', async (t) => {
  switchReferrals(t);
  const deleted = stubBlob(t);
  for (const verb of contract.REFERRAL_DELETE_BLOCKING_EVENT_VERBS) {
    await t.test(verb, async (tt) => {
      const { baseUrl, db } = await boot(tt, { role: 'tc' });
      const row = await draft(baseUrl, db);
      attachment(db, row.referral_id);
      event(db, row, verb);
      const r = await api(baseUrl, 'DELETE', REF(`/${row.referral_id}`));
      assert.deepEqual([r.status, r.body.code], [409, 'REFERRAL_DELETE_HAS_HISTORY'], verb);
      assert.equal(db.table('tc_referrals').length, 1);
      assert.equal(db.table('tc_referral_attachments').length, 1);
    });
  }
  assert.deepEqual(deleted, []);
  // The pinned set, exactly.
  assert.deepEqual([...contract.REFERRAL_DELETE_BLOCKING_EVENT_VERBS].sort(), [
    'chart_note_written',
    'correspondence',
    'mark_sent',
    'patient_email_failed',
    'patient_email_sent',
    'patient_email_skipped',
    'patient_scheduled',
    'send',
    'send_conflict',
    'send_failed',
  ]);
});

test('D2: a draft with a live email claim is refused; a stale one is not', async (t) => {
  switchReferrals(t);
  stubBlob(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const row = await draft(baseUrl, db);
  row.send_attempt_id = randomUUID();
  row.send_attempt_at = NOW.toISOString();
  const r = await api(baseUrl, 'DELETE', REF(`/${row.referral_id}`));
  assert.deepEqual([r.status, r.body.code], [409, 'REFERRAL_SEND_IN_PROGRESS']);
  row.send_attempt_at = new Date(NOW.getTime() - 10 * 60_000).toISOString();
  assert.equal((await api(baseUrl, 'DELETE', REF(`/${row.referral_id}`))).status, 200);
});

test('D3: a failed audit write rolls the delete back, and no file is deleted', async (t) => {
  switchReferrals(t);
  const deleted = stubBlob(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const row = await draft(baseUrl, db);
  attachment(db, row.referral_id);
  realTransactions(db);
  db.onQuery(/INSERT INTO audit_log/, () => {
    throw new Error('audit store down');
  });
  const r = await api(baseUrl, 'DELETE', REF(`/${row.referral_id}`));
  assert.equal(r.status, 500);
  assert.equal(db.table('tc_referrals').length, 1, 'the draft is still there');
  assert.equal(db.table('tc_referral_attachments').length, 1);
  assert.ok(db.table('tc_referral_events').length >= 1, 'its history too');
  assert.deepEqual(deleted, []);
});

test('D3: a file storage would not delete is counted (filesLeft), never reported as removed', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const row = await draft(baseUrl, db);
  const bad = attachment(db, row.referral_id);
  attachment(db, row.referral_id);
  stubBlob(t, { fail: [bad.blob_key] });
  const warn = t.mock.method(console, 'warn', () => {});
  const r = await api(baseUrl, 'DELETE', REF(`/${row.referral_id}`));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.filesRemoved, r.body.filesLeft], [1, 1]);
  assert.equal(db.table('tc_referral_attachments').length, 0, 'no row points at the left file');
  // Logged by count and id only.
  assert.match(String(warn.mock.calls[0].arguments[0]), /1 attachment file\(s\) left/);
  assert.doesNotMatch(String(warn.mock.calls[0].arguments[0]), /Stedi|12827|xray/);
});

test('D: bad id is 400; unknown is 404', async (t) => {
  switchReferrals(t);
  const { baseUrl } = await boot(t, { role: 'tc' });
  assert.equal((await api(baseUrl, 'DELETE', REF('/not-a-uuid'))).status, 400);
  assert.equal((await api(baseUrl, 'DELETE', REF(`/${randomUUID()}`))).status, 404);
});

// ── P: permissions ──────────────────────────────────────────────────────────

test('P: a doctor (sign-off only) and hygiene cannot move or delete a referral; nothing changes', async (t) => {
  switchReferrals(t);
  const deleted = stubBlob(t);
  const admin = await boot(t);
  const row = await draft(admin.baseUrl, admin.db);
  attachment(admin.db, row.referral_id);
  for (const role of ['doctor', 'hygiene']) {
    const { baseUrl } = await boot(t, { role, user: { email: `${role}@carein.ai`, name: role, tenantId: 'x' }, db: admin.db });
    for (const status of ['draft', 'sent']) {
      row.status = status;
      for (const [path, , body] of TC_ROUTES) {
        const r = await api(baseUrl, 'POST', REF(`/${row.referral_id}/${path}`), body);
        assert.equal(r.status, 403, `${role} ${path} from ${status}`);
        assert.equal(row.status, status);
      }
    }
    row.status = 'draft';
    assert.equal((await api(baseUrl, 'DELETE', REF(`/${row.referral_id}`))).status, 403, `${role} delete`);
  }
  assert.equal(admin.db.table('tc_referrals').length, 1);
  assert.deepEqual(deleted, []);
});
