'use strict';

/**
 * Referrals R6 (queue item 56): the hub, staff edits, reopen, the doctor's
 * edits at sign-off, "send back with a question", and the manual marks.
 *
 *   T  the shared next-status table, pinned verb × status (it is still the one
 *      place a move is decided)
 *   H  the hub: every referral for the office, grouped/filtered, attachment
 *      counts, audited, dark when off, strict filters — and NOT for a doctor
 *   E  staff edits: draft + pending only, event + audit in-tx, CAS on status,
 *      a failed audit rolls back, strict bodies; approved needs reopen; sent+
 *      is read-only (409 REFERRAL_TRANSITION_NOT_ALLOWED)
 *   R  reopen: approved → pending_signoff, one transaction with its edit
 *   D  the doctor edits at sign-off, incl. doctor_note (cap 4000)
 *   Q  return: pending_signoff → draft with a required comment; the submitter
 *      sees "Returned by Dr. — <comment>"
 *   M  the marks: human attestations, the only way into sent+; nothing sends
 *
 * Test patients only (roland 12827); names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcReferrals = require('../../config/tcReferrals');
const transitions = require('./referralTransitions');
const contract = require('../../tc/contract.gen.cjs');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const NOW = new Date('2026-10-20T15:00:00.000Z');

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

const DOCTOR = { email: 'doctor@carein.ai', name: 'Doc', tenantId: 'x' };

function seedCase(db) {
  const row = { case_id: randomUUID(), office_id: 'roland', patient_name: 'Test 2, Stedi', od_patient_id: 12827, status: 'pending_tc' };
  db.table('tc_cases').push(row);
  return row;
}

function seedEntry(db, over = {}) {
  const row = { entry_id: randomUUID(), office_id: 'roland', practice_name: 'River Endodontics', specialty: 'Endodontics', active: true, ...over };
  db.table('tc_referral_directory').push(row);
  return row;
}

const REF = (p = '', office = 'roland', qs = '') => `/api/tc/referrals${p}?office=${office}${qs}`;
const SIGN = (p = '', office = 'roland') => `/api/tc/referrals/signoff${p}?office=${office}`;

const BODY = { reason: 'Possible cracked tooth, needs endo eval', urgency: 'soon', teeth: [3] };

async function create(baseUrl, caseRow, referral = BODY) {
  const r = await api(baseUrl, 'POST', REF(), { source: { caseId: caseRow.case_id }, referral });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.referral;
}

/** A referral walked to `status` through the real routes (admin holds both surfaces). */
async function walkTo(baseUrl, db, status) {
  const ref = await create(baseUrl, seedCase(db));
  const id = ref.referralId;
  const steps = {
    draft: [],
    pending_signoff: [[REF, '/submit']],
    approved: [[REF, '/submit'], [SIGN, '/approve']],
    sent: [[REF, '/submit'], [SIGN, '/approve'], [REF, '/mark-sent', { how: 'Faxed to the front desk' }]],
    acknowledged: [[REF, '/submit'], [SIGN, '/approve'], [REF, '/mark-sent', { how: 'Faxed' }], [REF, '/mark-acknowledged']],
    patient_seen: [
      [REF, '/submit'],
      [SIGN, '/approve'],
      [REF, '/mark-sent', { how: 'Faxed' }],
      [REF, '/mark-acknowledged'],
      [REF, '/mark-patient-seen'],
    ],
  }[status];
  for (const [base, p, body] of steps) {
    const r = await api(baseUrl, 'POST', base(`/${id}${p}`), body ?? {});
    assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.body)}`);
  }
  return id;
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

const referralUpdates = (db) => auditRows(db).filter((a) => a.resource_type === 'tc_referral' && a.action === 'UPDATE');

// ── T: the table ────────────────────────────────────────────────────────────

test('T: the shared next-status table, verb × status, exactly (sign-off required)', () => {
  const expected = {
    submit: { draft: 'pending_signoff' },
    withdraw: { pending_signoff: 'draft' },
    cancel: { draft: 'cancelled', pending_signoff: 'cancelled' },
    approve: { pending_signoff: 'approved' },
    decline: { pending_signoff: 'declined' },
    reopen: { approved: 'pending_signoff' },
    return: { pending_signoff: 'draft' },
    mark_sent: { approved: 'sent' },
    mark_acknowledged: { sent: 'acknowledged' },
    mark_patient_seen: { acknowledged: 'patient_seen' },
    close: { patient_seen: 'closed' },
  };
  assert.deepEqual([...contract.TcReferralVerb.options].sort(), Object.keys(expected).sort());
  for (const verb of contract.TcReferralVerb.options) {
    for (const from of contract.TcReferralStatus.options) {
      assert.equal(
        contract.referralNextStatus(from, verb, { signoffRequired: true }),
        expected[verb][from] ?? null,
        `${verb} from ${from}`
      );
    }
  }
  // Reopen goes back to sign-off even where sign-off is not required.
  assert.equal(contract.referralNextStatus('approved', 'reopen', { signoffRequired: false }), 'pending_signoff');
  // The only ways INTO sent and beyond are the three marks (and close).
  const intoSentPlus = [];
  for (const verb of contract.TcReferralVerb.options) {
    for (const from of contract.TcReferralStatus.options) {
      for (const signoffRequired of [true, false]) {
        const to = contract.referralNextStatus(from, verb, { signoffRequired });
        if (['sent', 'acknowledged', 'patient_seen', 'closed'].includes(to)) intoSentPlus.push(verb);
      }
    }
  }
  assert.deepEqual([...new Set(intoSentPlus)].sort(), ['close', 'mark_acknowledged', 'mark_patient_seen', 'mark_sent']);
});

test('T: every transition verb is an event verb; edit / doctor_edit / create are event-only', () => {
  const ev = new Set(contract.TC_REFERRAL_EVENT_VERBS);
  for (const v of contract.TcReferralVerb.options) assert.ok(ev.has(v), v);
  assert.deepEqual(
    [...ev].filter((v) => !contract.TcReferralVerb.options.includes(v)).sort(),
    ['create', 'doctor_edit', 'edit']
  );
});

// ── H: the hub ──────────────────────────────────────────────────────────────

test('H: the hub lists every referral for the office with attachment counts, audited as a list read', async (t) => {
  switchReferrals(t, { roland: true, valley: true });
  const { baseUrl, db } = await boot(t);
  const draft = await walkTo(baseUrl, db, 'draft');
  const pending = await walkTo(baseUrl, db, 'pending_signoff');
  const sent = await walkTo(baseUrl, db, 'sent');
  db.table('tc_referral_attachments').push(
    { attachment_id: randomUUID(), office_id: 'roland', referral_id: pending, file_name: 'a.png' },
    { attachment_id: randomUUID(), office_id: 'roland', referral_id: pending, file_name: 'b.png' }
  );
  const before = auditRows(db).length;
  const r = await api(baseUrl, 'GET', REF('/hub'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const byId = new Map(r.body.referrals.map((x) => [x.referralId, x]));
  assert.deepEqual([...byId.keys()].sort(), [draft, pending, sent].sort());
  assert.equal(byId.get(pending).attachmentCount, 2);
  assert.equal(byId.get(draft).attachmentCount, 0);
  assert.deepEqual(
    r.body.referrals.map((x) => contract.referralHubGroup(x.status)).sort(),
    ['drafts', 'sent', 'signoff']
  );
  const reads = auditRows(db).slice(before);
  assert.deepEqual(reads.map((a) => [a.action, a.resource_type, a.resource_id, a.source_ref]), [
    ['READ', 'tc_referral', null, 'referral_hub'],
  ]);
  // Office-scoped: valley sees none of roland's.
  assert.deepEqual((await api(baseUrl, 'GET', REF('/hub', 'valley'))).body.referrals, []);
});

test('H: filters — status, specialist, source, age — and unknown or smuggled keys are 400', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const endo = seedEntry(db);
  const perio = seedEntry(db, { practice_name: 'Valley Periodontics', specialty: 'Periodontics' });
  const a = await create(baseUrl, seedCase(db), { ...BODY, directoryEntryId: endo.entry_id });
  const b = await create(baseUrl, seedCase(db), { ...BODY, directoryEntryId: perio.entry_id });
  await api(baseUrl, 'POST', REF(`/${b.referralId}/submit`));
  // a has sat in draft for 4 days.
  db.table('tc_referrals').find((r) => r.referral_id === a.referralId).status_changed_at = '2026-10-16T12:00:00.000Z';

  const ids = async (qs) => (await api(baseUrl, 'GET', REF('/hub', 'roland', qs))).body.referrals.map((x) => x.referralId);
  assert.deepEqual(await ids('&status=pending_signoff'), [b.referralId]);
  assert.deepEqual(await ids(`&directoryEntryId=${endo.entry_id}`), [a.referralId]);
  assert.deepEqual((await ids('&sourceKind=case')).sort(), [a.referralId, b.referralId].sort());
  assert.deepEqual(await ids('&sourceKind=checkout'), []);
  assert.deepEqual(await ids('&minAgeDays=3'), [a.referralId]);
  for (const qs of ['&status=nope', '&minAgeDays=-1', '&directoryEntryId=x', '&officeId=valley', '&patientId=12827']) {
    const r = await api(baseUrl, 'GET', REF('/hub', 'roland', qs));
    assert.equal(r.status, 400, qs);
    assert.equal(r.body.code, 'INVALID_FILTER');
  }
});

test('H: dark when referrals is off for the office', async (t) => {
  switchReferrals(t, { roland: false });
  const { baseUrl } = await boot(t);
  const r = await api(baseUrl, 'GET', REF('/hub'));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'REFERRALS_DISABLED');
});

test('H: a DOCTOR does not reach the hub, the staff edit, reopen or any mark (tc.full excludes doctor)', async (t) => {
  switchReferrals(t);
  const admin = await boot(t);
  const id = await walkTo(admin.baseUrl, admin.db, 'approved');
  const doc = await boot(t, { role: 'doctor', user: DOCTOR, db: admin.db });
  const tries = [
    ['GET', REF('/hub')],
    ['PATCH', REF(`/${id}/fields`), { urgency: 'urgent' }],
    ['POST', REF(`/${id}/reopen`), {}],
    ['POST', REF(`/${id}/mark-sent`), { how: 'Faxed' }],
    ['POST', REF(`/${id}/mark-acknowledged`), {}],
    ['POST', REF(`/${id}/mark-patient-seen`), {}],
    ['POST', REF(`/${id}/close`), {}],
  ];
  for (const [method, p, body] of tries) {
    assert.equal((await api(doc.baseUrl, method, p, body)).status, 403, `${method} ${p}`);
  }
  assert.equal(admin.db.table('tc_referrals')[0].status, 'approved');
  // ... and the permission map agrees: tc.full is not a doctor's.
  const { roleHasPermission } = require('../../config/permissions');
  assert.equal(roleHasPermission('doctor', 'tc.full'), false);
  assert.equal(roleHasPermission('doctor', 'tc.referral_signoff'), true);
});

test('H: hub roles — tc, office and admin reach it; hygiene does not', async (t) => {
  switchReferrals(t);
  for (const [role, status] of [['tc', 200], ['office', 200], ['admin', 200], ['hygiene', 403]]) {
    await t.test(role, async (tt) => {
      const { baseUrl } = await boot(tt, { role });
      assert.equal((await api(baseUrl, 'GET', REF('/hub'))).status, status, role);
    });
  }
});

// ── E: staff edits ──────────────────────────────────────────────────────────

test('E: a draft and one awaiting sign-off take a field edit — event (from = to, verb edit) + one audit row', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const entry = seedEntry(db);
  for (const status of ['draft', 'pending_signoff']) {
    const id = await walkTo(baseUrl, db, status);
    const audits = referralUpdates(db).length;
    const r = await api(baseUrl, 'PATCH', REF(`/${id}/fields`), {
      directoryEntryId: entry.entry_id,
      urgency: 'urgent',
      reason: 'Cracked cusp, endo eval',
      teeth: [3, 4],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.referral.status, status, 'the status did not move');
    assert.equal(r.body.referral.urgency, 'urgent');
    assert.deepEqual(r.body.referral.teeth, [3, 4]);
    assert.equal(r.body.referral.practiceName, 'River Endodontics');
    const last = r.body.referral.events.at(-1);
    assert.deepEqual([last.fromStatus, last.toStatus, last.verb, last.actor], [status, status, 'edit', 'tc@carein.ai']);
    assert.equal(last.note, 'Changed specialist, how soon (Soon → Urgent), reason, teeth');
    const after = referralUpdates(db).slice(audits);
    assert.deepEqual(after.map((a) => [a.resource_id, a.prior_state]), [[id, status]]);
  }
});

test('E: a no-op edit writes no event and no audit row', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'draft');
  const events = db.table('tc_referral_events').length;
  const audits = auditRows(db).length;
  const same = await api(baseUrl, 'PATCH', REF(`/${id}/fields`), { urgency: 'soon', teeth: [3] });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(db.table('tc_referral_events').length, events);
  assert.equal(auditRows(db).length, audits);
});

test('E: strict bodies — smuggled office / patient / status / doctorNote, and an empty edit, are 400; nothing changes', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'draft');
  for (const body of [
    {},
    { urgency: 'urgent', officeId: 'valley' },
    { urgency: 'urgent', odPatientId: 7115 },
    { urgency: 'urgent', patientName: 'Someone Else' },
    { urgency: 'urgent', status: 'sent' },
    { urgency: 'urgent', doctorNote: 'staff cannot write this' },
    { reason: '' },
    { urgency: 'asap' },
  ]) {
    const r = await api(baseUrl, 'PATCH', REF(`/${id}/fields`), body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const row = db.table('tc_referrals')[0];
  assert.deepEqual([row.urgency, row.office_id, Number(row.od_patient_id), row.status], ['soon', 'roland', 12827, 'draft']);
});

test('E: an inactive or unknown specialist is refused and nothing is written', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'draft');
  const off = seedEntry(db, { active: false });
  const events = db.table('tc_referral_events').length;
  const a = await api(baseUrl, 'PATCH', REF(`/${id}/fields`), { directoryEntryId: off.entry_id });
  assert.deepEqual([a.status, a.body.code], [409, 'DIRECTORY_ENTRY_INACTIVE']);
  const b = await api(baseUrl, 'PATCH', REF(`/${id}/fields`), { directoryEntryId: randomUUID() });
  assert.deepEqual([b.status, b.body.code], [404, 'DIRECTORY_ENTRY_NOT_FOUND']);
  assert.equal(db.table('tc_referral_events').length, events);
});

test('E: approved needs reopen; sent and beyond are read-only — 409 REFERRAL_TRANSITION_NOT_ALLOWED', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  for (const status of ['approved', 'sent', 'acknowledged', 'patient_seen']) {
    const id = await walkTo(baseUrl, db, status);
    const r = await api(baseUrl, 'PATCH', REF(`/${id}/fields`), { urgency: 'urgent' });
    assert.equal(r.status, 409, status);
    assert.equal(r.body.code, 'REFERRAL_TRANSITION_NOT_ALLOWED');
    assert.equal(r.body.currentStatus, status);
    if (status === 'approved') assert.match(r.body.error, /Reopen it for re-approval/);
    if (status !== 'approved') {
      const re = await api(baseUrl, 'POST', REF(`/${id}/reopen`), { fields: { urgency: 'urgent' } });
      assert.deepEqual([re.status, re.body.code], [409, 'REFERRAL_TRANSITION_NOT_ALLOWED'], `reopen from ${status}`);
    }
    assert.equal(db.table('tc_referrals').find((x) => x.referral_id === id).urgency, 'soon');
  }
});

test('E: CAS — an edit that loses a race with a transition is a 409, and writes no event', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'pending_signoff');
  // The doctor approves between the edit's read and its write.
  db.onQuery(/^UPDATE tc_referrals SET urgency = \$4/, () => {
    db.table('tc_referrals').find((r) => r.referral_id === id).status = 'approved';
    return { rows: [], rowCount: 0 };
  });
  const events = db.table('tc_referral_events').length;
  const r = await api(baseUrl, 'PATCH', REF(`/${id}/fields`), { urgency: 'urgent' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'REFERRAL_TRANSITION_NOT_ALLOWED');
  assert.equal(r.body.currentStatus, 'approved');
  assert.equal(db.table('tc_referral_events').length, events);
});

test('E: a failed audit write rolls the edit and its event back', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'draft');
  const events = db.table('tc_referral_events').length;
  realTransactions(db);
  db.onQuery(/INSERT INTO audit_log/, () => {
    throw new Error('audit store down');
  });
  const r = await api(baseUrl, 'PATCH', REF(`/${id}/fields`), { urgency: 'urgent' });
  assert.equal(r.status, 500);
  assert.equal(db.table('tc_referrals')[0].urgency, 'soon');
  assert.equal(db.table('tc_referral_events').length, events);
});

// ── R: reopen ───────────────────────────────────────────────────────────────

test('R: reopen + edit is ONE transaction — approved → pending_signoff, reopen event, edit event, two audit rows', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'approved');
  const audits = referralUpdates(db).length;
  const r = await api(baseUrl, 'POST', REF(`/${id}/reopen`), { fields: { urgency: 'urgent' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.referral.status, 'pending_signoff');
  assert.equal(r.body.referral.urgency, 'urgent');
  assert.deepEqual(
    r.body.referral.events.slice(-2).map((e) => [e.fromStatus, e.toStatus, e.verb]),
    [
      ['approved', 'pending_signoff', 'reopen'],
      ['pending_signoff', 'pending_signoff', 'edit'],
    ]
  );
  assert.deepEqual(referralUpdates(db).slice(audits).map((a) => a.prior_state), ['approved', 'pending_signoff']);
  // It needs the doctor again: approve works, and nothing went anywhere.
  assert.equal((await api(baseUrl, 'POST', SIGN(`/${id}/approve`))).body.referral.status, 'approved');
});

test('R: a refused edit rolls the reopen back — the referral stays approved', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'approved');
  const off = seedEntry(db, { active: false });
  realTransactions(db);
  const events = db.table('tc_referral_events').length;
  const audits = auditRows(db).length;
  const r = await api(baseUrl, 'POST', REF(`/${id}/reopen`), { fields: { directoryEntryId: off.entry_id } });
  assert.deepEqual([r.status, r.body.code], [409, 'DIRECTORY_ENTRY_INACTIVE']);
  assert.equal(db.table('tc_referrals')[0].status, 'approved');
  assert.equal(db.table('tc_referral_events').length, events);
  assert.equal(auditRows(db).length, audits);
});

test('R: reopen from anything but approved is 409; a bare reopen (no fields) just moves it back', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const draft = await walkTo(baseUrl, db, 'draft');
  const pending = await walkTo(baseUrl, db, 'pending_signoff');
  for (const id of [draft, pending]) {
    const r = await api(baseUrl, 'POST', REF(`/${id}/reopen`), {});
    assert.deepEqual([r.status, r.body.code], [409, 'REFERRAL_TRANSITION_NOT_ALLOWED']);
  }
  const approved = await walkTo(baseUrl, db, 'approved');
  const r = await api(baseUrl, 'POST', REF(`/${approved}/reopen`), {});
  assert.equal(r.body.referral.status, 'pending_signoff');
  assert.equal((await api(baseUrl, 'POST', REF(`/${approved}/reopen`), { fields: {} })).status, 400, 'an empty edit');
  assert.equal((await api(baseUrl, 'POST', REF(`/${approved}/reopen`), { status: 'draft' })).status, 400, 'strict');
});

// ── D: the doctor edits at sign-off ─────────────────────────────────────────

test('D: the doctor edits specialist / urgency / reason / teeth and their own note — doctor_edit event + audit', async (t) => {
  switchReferrals(t);
  const admin = await boot(t);
  const id = await walkTo(admin.baseUrl, admin.db, 'pending_signoff');
  const entry = seedEntry(admin.db, { practice_name: 'Valley Oral Surgery', specialty: 'Oral surgery' });
  const doc = await boot(t, { role: 'doctor', user: DOCTOR, db: admin.db });

  const dir = await api(doc.baseUrl, 'GET', SIGN('/directory'));
  assert.equal(dir.status, 200);
  assert.deepEqual(dir.body.entries.map((e) => e.practiceName), ['Valley Oral Surgery']);

  const audits = referralUpdates(admin.db).length;
  const r = await api(doc.baseUrl, 'PATCH', SIGN(`/${id}/fields`), {
    directoryEntryId: entry.entry_id,
    urgency: 'urgent',
    teeth: 'mouth',
    doctorNote: 'Please see within the week.',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.referral.status, 'pending_signoff');
  assert.equal(r.body.referral.doctorNote, 'Please see within the week.');
  assert.equal(r.body.referral.teeth, 'mouth');
  const last = r.body.referral.events.at(-1);
  assert.deepEqual([last.verb, last.actor, last.fromStatus, last.toStatus], ['doctor_edit', 'doctor@carein.ai', 'pending_signoff', 'pending_signoff']);
  assert.match(last.note, /doctor's note/);
  assert.deepEqual(referralUpdates(admin.db).slice(audits).map((a) => a.prior_state), ['pending_signoff']);

  // Approve still works after the doctor's edit, with the same rules as before.
  const ok = await api(doc.baseUrl, 'POST', SIGN(`/${id}/approve`));
  assert.equal(ok.body.referral.status, 'approved');
  assert.equal(ok.body.referral.doctorNote, 'Please see within the week.');
});

test('D: the doctor may edit ONLY while it awaits sign-off; the note is capped; bodies are strict', async (t) => {
  switchReferrals(t);
  const admin = await boot(t);
  const pending = await walkTo(admin.baseUrl, admin.db, 'pending_signoff');
  const toReturn = await walkTo(admin.baseUrl, admin.db, 'pending_signoff');
  const others = {};
  for (const status of ['draft', 'approved', 'sent']) others[status] = await walkTo(admin.baseUrl, admin.db, status);
  // Booted LAST: the harness's role stub is process-wide.
  const doc = await boot(t, { role: 'doctor', user: DOCTOR, db: admin.db });
  const long = 'x'.repeat(contract.TC_REFERRAL_DOCTOR_NOTE_MAX + 1);
  for (const body of [{ doctorNote: long }, { urgency: 'urgent', odPatientId: 1 }, { urgency: 'urgent', officeId: 'valley' }, {}]) {
    assert.equal((await api(doc.baseUrl, 'PATCH', SIGN(`/${pending}/fields`), body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal(
    (await api(doc.baseUrl, 'PATCH', SIGN(`/${pending}/fields`), { doctorNote: 'x'.repeat(contract.TC_REFERRAL_DOCTOR_NOTE_MAX) })).status,
    200
  );
  // A blank note clears it.
  const cleared = await api(doc.baseUrl, 'PATCH', SIGN(`/${pending}/fields`), { doctorNote: '   ' });
  assert.equal(cleared.body.referral.doctorNote, null);
  for (const [status, id] of Object.entries(others)) {
    const r = await api(doc.baseUrl, 'PATCH', SIGN(`/${id}/fields`), { urgency: 'urgent' });
    assert.equal(r.status, 409, status);
    assert.equal(r.body.code, 'REFERRAL_TRANSITION_NOT_ALLOWED');
  }
  // The doctor role (not only admin) may send one back.
  const back = await api(doc.baseUrl, 'POST', SIGN(`/${toReturn}/return`), { comment: 'Which specialist?' });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.referral.status, 'draft');
});

test('D: roles without tc.referral_signoff cannot use the doctor edit, return or the sign-off directory', async (t) => {
  switchReferrals(t);
  const admin = await boot(t);
  const id = await walkTo(admin.baseUrl, admin.db, 'pending_signoff');
  for (const role of ['tc', 'office', 'hygiene']) {
    await t.test(role, async (tt) => {
      const { baseUrl } = await boot(tt, { role, db: admin.db });
      assert.equal((await api(baseUrl, 'PATCH', SIGN(`/${id}/fields`), { urgency: 'urgent' })).status, 403);
      assert.equal((await api(baseUrl, 'POST', SIGN(`/${id}/return`), { comment: 'x' })).status, 403);
      assert.equal((await api(baseUrl, 'GET', SIGN('/directory'))).status, 403);
    });
  }
  assert.equal(admin.db.table('tc_referrals')[0].status, 'pending_signoff');
});

// ── Q: send back with a question ────────────────────────────────────────────

test('Q: return needs a comment; it sends the referral back to draft and the submitter sees the question', async (t) => {
  switchReferrals(t);
  // Two people, interleaved. The harness's role stub is process-wide, so both
  // apps run as admin (which holds both surfaces); they differ by WHO is signed
  // in. The doctor role's own access to return is pinned in the D tests.
  const tc = await boot(t);
  const c = seedCase(tc.db);
  const ref = await create(tc.baseUrl, c);
  await api(tc.baseUrl, 'POST', REF(`/${ref.referralId}/submit`));
  const doc = await boot(t, { user: DOCTOR, db: tc.db });

  for (const body of [{}, { comment: '' }, { comment: '   ' }, { comment: 'ok', status: 'draft' }]) {
    assert.equal((await api(doc.baseUrl, 'POST', SIGN(`/${ref.referralId}/return`), body)).status, 400, JSON.stringify(body));
  }
  assert.equal(tc.db.table('tc_referrals')[0].status, 'pending_signoff');

  const r = await api(doc.baseUrl, 'POST', SIGN(`/${ref.referralId}/return`), { comment: 'Which tooth — 3 or 14?' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.referral.status, 'draft');
  const last = r.body.referral.events.at(-1);
  assert.deepEqual([last.verb, last.note, last.actor], ['return', 'Which tooth — 3 or 14?', 'doctor@carein.ai']);

  // The submitter's surface (the case's list) carries it…
  const list = await api(tc.baseUrl, 'GET', REF('', 'roland', `&caseId=${c.case_id}`));
  const row = list.body.referrals[0];
  assert.equal(contract.referralReturnedLine(row.returned), 'Returned by Dr. — Which tooth — 3 or 14?');
  // …through an edit…
  await api(tc.baseUrl, 'PATCH', REF(`/${ref.referralId}/fields`), { teeth: [3] , reason: 'Tooth #3: cracked cusp' });
  const detail = await api(tc.baseUrl, 'GET', REF(`/${ref.referralId}`));
  assert.equal(detail.body.referral.returned.note, 'Which tooth — 3 or 14?');
  // …until it is resubmitted.
  const again = await api(tc.baseUrl, 'POST', REF(`/${ref.referralId}/submit`));
  assert.equal(again.body.referral.returned, null);
  // Return is only from sign-off.
  await api(doc.baseUrl, 'POST', SIGN(`/${ref.referralId}/approve`));
  const late = await api(doc.baseUrl, 'POST', SIGN(`/${ref.referralId}/return`), { comment: 'too late' });
  assert.deepEqual([late.status, late.body.code], [409, 'REFERRAL_TRANSITION_NOT_ALLOWED']);
});

test('Q: a withdraw is not a return — no "Returned by Dr." line', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'pending_signoff');
  const r = await api(baseUrl, 'POST', REF(`/${id}/withdraw`));
  assert.equal(r.body.referral.status, 'draft');
  assert.equal(r.body.referral.returned, null);
});

// ── M: the manual marks ─────────────────────────────────────────────────────

test('M: approved → sent → acknowledged → patient_seen → closed, each a recorded attestation', async (t) => {
  switchReferrals(t);
  const admin = await boot(t);
  const db = admin.db;
  const id = await walkTo(admin.baseUrl, db, 'approved');
  // The TC (tc.full) records the marks. Booted last: the role stub is process-wide.
  const { baseUrl } = await boot(t, { role: 'tc', db });

  assert.equal((await api(baseUrl, 'POST', REF(`/${id}/mark-sent`), {})).status, 400, 'how is required');
  assert.equal((await api(baseUrl, 'POST', REF(`/${id}/mark-sent`), { how: '  ' })).status, 400);
  assert.equal((await api(baseUrl, 'POST', REF(`/${id}/mark-sent`), { how: 'x', officeId: 'valley' })).status, 400);

  const audits = referralUpdates(db).length;
  const sent = await api(baseUrl, 'POST', REF(`/${id}/mark-sent`), { how: 'Faxed to their front desk' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.referral.status, 'sent');
  assert.equal(sent.body.referral.events.at(-1).note, 'Sent outside the app: Faxed to their front desk');
  for (const [p, to] of [['/mark-acknowledged', 'acknowledged'], ['/mark-patient-seen', 'patient_seen'], ['/close', 'closed']]) {
    const r = await api(baseUrl, 'POST', REF(`/${id}${p}`), {});
    assert.equal(r.status, 200, p);
    assert.equal(r.body.referral.status, to);
  }
  const ev = (await api(baseUrl, 'GET', REF(`/${id}`))).body.referral.events.slice(-4);
  assert.deepEqual(ev.map((e) => [e.fromStatus, e.toStatus, e.verb]), [
    ['approved', 'sent', 'mark_sent'],
    ['sent', 'acknowledged', 'mark_acknowledged'],
    ['acknowledged', 'patient_seen', 'mark_patient_seen'],
    ['patient_seen', 'closed', 'close'],
  ]);
  assert.deepEqual(referralUpdates(db).slice(audits).map((a) => a.prior_state), ['approved', 'sent', 'acknowledged', 'patient_seen']);
});

test('M: marks out of order are 409, and nothing skips a step', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const draft = await walkTo(baseUrl, db, 'draft');
  const pending = await walkTo(baseUrl, db, 'pending_signoff');
  const approved = await walkTo(baseUrl, db, 'approved');
  const tries = [
    [draft, '/mark-sent', { how: 'x' }],
    [pending, '/mark-sent', { how: 'x' }],
    [approved, '/mark-acknowledged', {}],
    [approved, '/mark-patient-seen', {}],
    [approved, '/close', {}],
  ];
  for (const [id, p, body] of tries) {
    const r = await api(baseUrl, 'POST', REF(`/${id}${p}`), body);
    assert.deepEqual([r.status, r.body.code], [409, 'REFERRAL_TRANSITION_NOT_ALLOWED'], p);
  }
});

test('M: a failed audit write rolls a mark back', async (t) => {
  switchReferrals(t);
  const { baseUrl, db } = await boot(t);
  const id = await walkTo(baseUrl, db, 'approved');
  realTransactions(db);
  db.onQuery(/INSERT INTO audit_log/, () => {
    throw new Error('audit store down');
  });
  assert.equal((await api(baseUrl, 'POST', REF(`/${id}/mark-sent`), { how: 'Faxed' })).status, 500);
  assert.equal(db.table('tc_referrals')[0].status, 'approved');
});

test('M: nothing sends — no messaging is reachable from the referral routes, and auto-send stays consumed by nothing', () => {
  const dir = __dirname;
  const files = ['referrals.js', 'referralSignoff.js', 'referralTransitions.js', 'referralStore.js', 'referralCreate.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /require\([^)]*(messaging|email|fax|sms|acs|twilio|nodemailer)[^)]*\)/i, f);
  }
  // autosend_on_approval is READ only to show and store the setting.
  const readers = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.js$/.test(ent.name) && !/\.test\.js$/.test(ent.name) && !/\.gen\.cjs$/.test(ent.name)) {
        const src = fs.readFileSync(p, 'utf8');
        if (/autosendOnApproval|autosend_on_approval/.test(src)) readers.push(path.relative(path.join(dir, '../..'), p).replace(/\\/g, '/'));
      }
    }
  };
  walk(path.join(dir, '../..', 'routes'));
  walk(path.join(dir, '../..', 'services'));
  assert.deepEqual(readers.sort(), ['routes/tc/referralStore.js', 'routes/tc/referrals.js']);
});
