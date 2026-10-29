'use strict';

/**
 * Referrals R6.9: the correspondence log.
 *
 *   V  the verb: a non-move event verb in the shared vocabulary; the
 *      transition table is untouched (no verb × status changes)
 *   L  POST /:id/correspondence: event + audit in one transaction, the status
 *      never moves, a failed audit rolls the event back, the answer is the
 *      read-back with the history row (direction / party / channel / note)
 *   S  per-status availability: every status but a draft; a draft is a 409
 *      that writes nothing
 *   B  strict body: smuggled office / status / actor / at / verb, an unknown
 *      channel, a blank or over-long note → 400, nothing written
 *   O  office server-derived: another office's referral is a 404, a doctor
 *      (no tc.full) is refused at the mount
 *   A  a file with it goes through R4's route UNCHANGED: its cap of 5 refuses
 *      the sixth honestly and the logged contact stands; once closed R4
 *      refuses by status (REFERRAL_LOCKED) — R6.9a opened sent / acknowledged
 *      / patient seen to staff
 *   C  the card line: lastCorrespondence on the hub and the case list, from
 *      the one batched events query (no per-row query)
 *
 * Test patient only (roland 12827); names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const transitions = require('./referralTransitions');
const blob = require('../../services/tc/referralAttachmentStore');
const contract = require('../../tc/contract.gen.cjs');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const NOW = new Date('2026-10-27T15:00:00.000Z');
const DOCTOR = { email: 'doctor@carein.ai', name: 'Doc', tenantId: 'x' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

function switchReferrals(t) {
  const orig = registry.getPlatformSetting;
  const keep = {
    a: process.env.REFERRAL_SIGNOFF_REQUIRED_ROLAND,
    b: process.env.TC_REFERRALS_ENABLED_ROLAND,
  };
  delete process.env.REFERRAL_SIGNOFF_REQUIRED_ROLAND;
  delete process.env.TC_REFERRALS_ENABLED_ROLAND;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_referrals_enabled' ? { key, value: { roland: true, valley: true }, updated_at: new Date(), updated_by: null } : null;
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

function fakeBlob(t) {
  const saved = Object.fromEntries(['isConfigured', 'putAttachment'].map((k) => [k, blob[k]]));
  blob.isConfigured = () => true;
  blob.putAttachment = async ({ tenantSlug, data, contentType }) => ({ key: blob.buildKey({ tenantSlug, contentType }), bytes: data.length });
  t.after(() => Object.assign(blob, saved));
}

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

const REF = (p = '', office = 'roland') => `/api/tc/referrals${p}?office=${office}`;
const SIGN = (p = '') => `/api/tc/referrals/signoff${p}?office=roland`;

function seedCase(db) {
  const row = { case_id: randomUUID(), office_id: 'roland', patient_name: 'Test 2, Stedi', od_patient_id: 12827, status: 'pending_tc' };
  db.table('tc_cases').push(row);
  return row;
}

/** A referral walked to `status` through the real routes. */
async function walkTo(baseUrl, db, status) {
  const c = seedCase(db);
  const r = await api(baseUrl, 'POST', REF(), {
    source: { caseId: c.case_id },
    referral: { reason: 'Possible cracked tooth', urgency: 'soon', teeth: [3] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.referral.referralId;
  const steps = {
    draft: [],
    pending_signoff: [[REF, '/submit']],
    approved: [[REF, '/submit'], [SIGN, '/approve']],
    declined: [[REF, '/submit'], [SIGN, '/decline', { reason: 'Not needed yet' }]],
    cancelled: [[REF, '/cancel']],
    sent: [[REF, '/submit'], [SIGN, '/approve'], [REF, '/mark-sent', { how: 'Faxed' }]],
    acknowledged: [[REF, '/submit'], [SIGN, '/approve'], [REF, '/mark-sent', { how: 'Faxed' }], [REF, '/mark-acknowledged']],
    patient_seen: [
      [REF, '/submit'],
      [SIGN, '/approve'],
      [REF, '/mark-sent', { how: 'Faxed' }],
      [REF, '/mark-acknowledged'],
      [REF, '/mark-patient-seen'],
    ],
    closed: [
      [REF, '/submit'],
      [SIGN, '/approve'],
      [REF, '/mark-sent', { how: 'Faxed' }],
      [REF, '/mark-acknowledged'],
      [REF, '/mark-patient-seen'],
      [REF, '/close'],
    ],
  }[status];
  for (const [base, p, body] of steps) {
    const res = await api(baseUrl, 'POST', base(`/${id}${p}`), body ?? {});
    assert.equal(res.status, 200, `${p}: ${JSON.stringify(res.body)}`);
  }
  return { id, caseId: c.case_id };
}

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

const BODY = Object.freeze({ direction: 'from', party: 'specialist', channel: 'phone', note: 'Front desk called: the patient is booked for Nov 3.' });
const log = (baseUrl, id, body = BODY, office = 'roland') => api(baseUrl, 'POST', REF(`/${id}/correspondence`, office), body);
const correspondenceAudits = (db) => auditRows(db).filter((a) => a.source_ref === 'referral_correspondence');

async function upload(baseUrl, referralId, name) {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), name);
  const res = await fetch(`${baseUrl}/api/tc/referrals/${referralId}/attachments?office=roland`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}

// ── V: the verb ─────────────────────────────────────────────────────────────

test('V: `correspondence` is an event verb, last in R6.9\'s CHECK order, and never a move', () => {
  // R6.10 appended `chart_note_written` after it; R6.9's own list is frozen.
  const verbs = [...contract.TC_REFERRAL_R69_EVENT_VERBS];
  assert.equal(verbs[verbs.length - 1], 'correspondence');
  assert.ok(contract.TcReferralEventVerb.options.includes('correspondence'));
  assert.deepEqual([...contract.TC_REFERRAL_R69_EVENT_VERBS], [...contract.TC_REFERRAL_R5B_EVENT_VERBS, 'correspondence']);
  assert.equal(contract.TcReferralVerb.options.includes('correspondence'), false, 'not a verb a move route can name');
  // A correspondence row after a move does not hide that move's meaning.
  const ev = (over) => ({ eventId: randomUUID(), fromStatus: 'draft', toStatus: 'draft', actor: 'a', at: NOW.toISOString(), note: '', ...over });
  const events = [
    ev({ fromStatus: 'pending_signoff', toStatus: 'draft', verb: 'return', note: 'Which tooth?' }),
    ev({ verb: 'correspondence', note: 'Called the patient', correspondence: { direction: 'to', party: 'patient', channel: 'phone' } }),
  ];
  assert.deepEqual(contract.referralLastReturn(events)?.note, 'Which tooth?');
});

test('V: the transition table is untouched — no status is reachable by correspondence', () => {
  for (const from of contract.TcReferralStatus.options) {
    for (const verb of contract.TcReferralVerb.options) {
      // Every move still answers as before; correspondence is not among them.
      contract.referralNextStatus(from, verb, { signoffRequired: true });
    }
  }
  const src = fs.readFileSync(path.join(__dirname, 'referralTransitions.js'), 'utf8');
  assert.doesNotMatch(src, /correspondence/, 'referralTransitions.js knows nothing of it');
  const send = fs.readFileSync(path.join(__dirname, 'referralSend.js'), 'utf8');
  assert.doesNotMatch(send, /correspondence/, 'the send path is untouched');
});

// ── L: the log ──────────────────────────────────────────────────────────────

test('L: logs on a sent referral — one event (from = to), one audit row, read back; nothing moves, nothing sends', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const { id } = await walkTo(baseUrl, db, 'sent');
  const before = db.table('tc_referral_events').length;
  const r = await log(baseUrl, id);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(contract.TcReferral.safeParse(r.body.referral).success, true);
  assert.equal(r.body.referral.status, 'sent', 'the status did not move');
  assert.equal(db.table('tc_referral_events').length, before + 1);
  const last = r.body.referral.events[r.body.referral.events.length - 1];
  assert.deepEqual(
    [last.verb, last.fromStatus, last.toStatus, last.note, last.actor, last.at],
    ['correspondence', 'sent', 'sent', BODY.note, 'tc@carein.ai', NOW.toISOString()]
  );
  assert.deepEqual(last.correspondence, { direction: 'from', party: 'specialist', channel: 'phone' });
  const stored = db.table('tc_referral_events').at(-1);
  assert.deepEqual(
    [stored.correspondence_direction, stored.correspondence_party, stored.correspondence_channel],
    ['from', 'specialist', 'phone']
  );
  const audits = correspondenceAudits(db);
  assert.equal(audits.length, 1);
  assert.deepEqual(
    [audits[0].action, audits[0].resource_type, audits[0].resource_id, audits[0].office, audits[0].prior_state],
    ['UPDATE', 'tc_referral', id, 'roland', 'sent']
  );
});

test('L: a failed audit write rolls the correspondence event back (500, nothing kept)', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const { id } = await walkTo(baseUrl, db, 'acknowledged');
  const before = db.table('tc_referral_events').length;
  realTransactions(db);
  db.onQuery(/INSERT INTO audit_log/, () => {
    throw new Error('audit store down');
  });
  const r = await log(baseUrl, id);
  assert.equal(r.status, 500);
  assert.equal(db.table('tc_referral_events').length, before);
  assert.equal(db.table('tc_referrals')[0].status, 'acknowledged');
});

// ── S: per-status availability ──────────────────────────────────────────────

test('S: every status but a draft accepts it; a draft is a 409 that writes nothing', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  assert.deepEqual(
    [...contract.REFERRAL_CORRESPONDENCE_STATUSES],
    contract.TcReferralStatus.options.filter((s) => s !== 'draft')
  );
  for (const status of contract.TcReferralStatus.options) {
    const { id } = await walkTo(baseUrl, db, status);
    const events = db.table('tc_referral_events').length;
    const audits = auditRows(db).length;
    const r = await log(baseUrl, id);
    if (status === 'draft') {
      assert.equal(r.status, 409, status);
      assert.equal(r.body.code, 'REFERRAL_CORRESPONDENCE_NOT_ALLOWED');
      assert.equal(r.body.currentStatus, 'draft');
      assert.equal(db.table('tc_referral_events').length, events, 'no event');
      assert.equal(auditRows(db).length, audits, 'no audit');
    } else {
      assert.equal(r.status, 201, `${status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.referral.status, status, `${status} stays ${status}`);
    }
    assert.equal(contract.referralCanLogCorrespondence(status), status !== 'draft');
  }
});

// ── B: strict body ──────────────────────────────────────────────────────────

test('B: strict body — smuggled fields, unknown vocabulary, blank or over-long notes are 400; nothing written', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const { id } = await walkTo(baseUrl, db, 'sent');
  const events = db.table('tc_referral_events').length;
  const max = contract.TC_REFERRAL_CORRESPONDENCE_NOTE_MAX;
  assert.equal(max, 2000);
  for (const body of [
    { ...BODY, office: 'valley' },
    { ...BODY, officeId: 'valley' },
    { ...BODY, status: 'closed' },
    { ...BODY, toStatus: 'closed' },
    { ...BODY, actor: 'someone@else' },
    { ...BODY, at: '2020-01-01T00:00:00.000Z' },
    { ...BODY, verb: 'mark_sent' },
    { ...BODY, channel: 'carrier pigeon' },
    { ...BODY, direction: 'sideways' },
    { ...BODY, party: 'insurer' },
    { ...BODY, note: '' },
    { ...BODY, note: '   ' },
    { ...BODY, note: 'x'.repeat(max + 1) },
    { direction: 'to', party: 'patient', channel: 'email' },
    {},
  ]) {
    const r = await log(baseUrl, id, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(db.table('tc_referral_events').length, events);
  // Exactly the cap is fine.
  assert.equal((await log(baseUrl, id, { ...BODY, note: 'x'.repeat(max) })).status, 201);
});

// ── O: office and role ──────────────────────────────────────────────────────

test("O: the office is the request's — another office's referral is a 404; a doctor is refused at the mount", async (t) => {
  switchReferrals(t);
  const admin = await boot(t);
  const { id } = await walkTo(admin.baseUrl, admin.db, 'sent');
  const events = admin.db.table('tc_referral_events').length;
  const other = await log(admin.baseUrl, id, BODY, 'valley');
  assert.equal(other.status, 404, JSON.stringify(other.body));
  const doc = await boot(t, { role: 'doctor', user: DOCTOR, db: admin.db });
  const r = await log(doc.baseUrl, id);
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(admin.db.table('tc_referral_events').length, events);
});

// ── A: a file with it, through R4 unchanged ─────────────────────────────────

test('A: at the cap of 5, R4 refuses the sixth file honestly — and the logged contact stands', async (t) => {
  switchReferrals(t);
  fakeBlob(t);
  const { baseUrl, db } = await boot(t);
  const { id } = await walkTo(baseUrl, db, 'pending_signoff');
  for (let i = 1; i <= contract.TC_REFERRAL_ATTACHMENT_MAX_FILES; i += 1) {
    assert.equal((await upload(baseUrl, id, `x${i}.png`)).status, 201);
  }
  const logged = await log(baseUrl, id, { ...BODY, channel: 'fax', note: 'Faxed the PA to their office' });
  assert.equal(logged.status, 201);
  const sixth = await upload(baseUrl, id, 'x6.png');
  assert.equal(sixth.status, 409);
  assert.equal(sixth.body.code, 'ATTACHMENT_LIMIT');
  assert.equal(sixth.body.error, 'A referral can carry at most 5 files.');
  assert.equal(db.table('tc_referral_attachments').length, 5);
  assert.equal(db.table('tc_referral_events').filter((e) => e.verb === 'correspondence').length, 1, 'the contact stays logged');
});

test('A: once closed R4 refuses any file by status (REFERRAL_LOCKED); its default rule is unchanged', async (t) => {
  // R6.9a widened the STAFF window to sent / acknowledged / patient seen, so
  // this pins a status that stays shut (closed) instead of `sent`.
  switchReferrals(t);
  fakeBlob(t);
  const { baseUrl, db } = await boot(t);
  const { id } = await walkTo(baseUrl, db, 'closed');
  assert.equal((await log(baseUrl, id)).status, 201);
  const r = await upload(baseUrl, id, 'fax.png');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'REFERRAL_LOCKED');
  const src = fs.readFileSync(path.join(__dirname, 'referralAttachments.js'), 'utf8');
  assert.match(src, /const ATTACHABLE_STATUSES = Object\.freeze\(\['draft', 'pending_signoff'\]\);/);
  assert.doesNotMatch(src, /correspondence/);
});

// ── C: the card line ────────────────────────────────────────────────────────

test('C: the hub and the case list carry the LATEST correspondence; none logged = null', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const a = await walkTo(baseUrl, db, 'sent');
  const b = await walkTo(baseUrl, db, 'approved');
  assert.equal((await log(baseUrl, a.id, { ...BODY, channel: 'email', direction: 'to', party: 'patient', note: 'Sent the map' })).status, 201);
  transitions.setClockForTests(() => new Date(NOW.getTime() + 60_000));
  assert.equal((await log(baseUrl, a.id)).status, 201);

  const hub = await api(baseUrl, 'GET', REF('/hub'));
  assert.equal(hub.status, 200);
  for (const row of hub.body.referrals) assert.equal(contract.TcReferral.safeParse(row).success, true);
  const rowA = hub.body.referrals.find((x) => x.referralId === a.id);
  assert.deepEqual(rowA.lastCorrespondence, {
    direction: 'from',
    party: 'specialist',
    channel: 'phone',
    note: BODY.note,
    actor: 'tc@carein.ai',
    at: new Date(NOW.getTime() + 60_000).toISOString(),
  });
  assert.equal(hub.body.referrals.find((x) => x.referralId === b.id).lastCorrespondence, null);

  const cases = await api(baseUrl, 'GET', `/api/tc/referrals?office=roland&caseId=${a.caseId}`);
  assert.equal(cases.status, 200);
  assert.equal(cases.body.referrals[0].lastCorrespondence.channel, 'phone');
  assert.equal(
    contract.referralLastContactLine(rowA.lastCorrespondence, 'America/Chicago'),
    'Last contact: phone from specialist, Oct 27'
  );
});

test('C: one batched events query per list read — not one per row', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  for (const s of ['sent', 'approved', 'pending_signoff', 'declined']) {
    const { id } = await walkTo(baseUrl, db, s);
    if (s !== 'approved') assert.equal((await log(baseUrl, id)).status, 201);
  }
  db.log.length = 0;
  const hub = await api(baseUrl, 'GET', REF('/hub'));
  assert.equal(hub.status, 200);
  assert.equal(hub.body.referrals.filter((r) => r.lastCorrespondence).length, 3);
  const eventReads = db.log.filter((q) => /FROM tc_referral_events/.test(q.sql));
  // openReturns (drafts: none here), openSendProblems (approved), responseSignals (all rows):
  // never more than those three, whatever the row count.
  assert.ok(eventReads.length <= 3, `${eventReads.length} event queries`);
  assert.ok(eventReads.every((q) => /referral_id = ANY\(\$2\)/.test(q.sql)), 'each one is batched');
});
