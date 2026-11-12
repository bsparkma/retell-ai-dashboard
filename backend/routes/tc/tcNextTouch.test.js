'use strict';

/**
 * Next touch: every OPEN TC case carries exactly one visible next touch (a date
 * and an owner), and an open case without one is flagged "No next step".
 *
 *   derivation  the next touch IS the case's earliest PENDING follow-up.
 *               Completed or skipped rows never count. Same-day ties are stable.
 *   open list   OPEN_CASE_STATUSES, unchanged: every working status, no
 *               terminal one, and not `scheduled`.
 *   bucket      GET /followups/next-touch lists one touch per open case, and
 *               puts every open case with no pending follow-up under noNextStep.
 *               Terminal cases appear in neither list.
 *   human route POST /cases/:id/status INTO an open status needs nextTouch
 *               (date + owner) unless a pending follow-up exists. 409
 *               NEXT_TOUCH_REQUIRED writes nothing. nextTouch on any other move
 *               is a 400.
 *   system      checkout routing (and the shared applyStatusChange it runs) is
 *               never blocked. The case lands in noNextStep instead.
 *   complete    completing or skipping the LAST pending touch of an open case
 *               answers nextTouchNeeded: true.
 *   office      everything is office-scoped. A valley case never shows in
 *               roland's view, and a roland write never lands in valley.
 *
 * Synthetic data only (roland 12827 "Test 2, Stedi", valley 7115
 * "Stedi TestValley").
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const contract = require('../../tc/contract.gen.cjs');
const caseStatus = require('./caseStatus');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const ACTOR = 'tc@carein.ai';

async function boot(t) {
  const app = await bootTcApp();
  t.after(() => app.close());
  return app;
}

function seedCase(db, over = {}) {
  const row = {
    case_id: randomUUID(),
    office_id: 'roland',
    od_patient_id: 12827,
    patient_name: 'Test 2, Stedi',
    phone: '',
    status: 'pending_tc',
    assigned_tc: 'owner@carein.ai',
    case_value_cents: 120000,
    urgency: 'medium',
    category: 'single_tooth',
    nurture_enrolled_at: null,
    status_changed_at: null,
    created_at: new Date('2026-11-01T12:00:00Z'),
    updated_at: new Date('2026-11-01T12:00:00Z'),
    ...over,
  };
  db.table('tc_cases').push(row);
  return row;
}

function seedFollowup(db, caseRow, over = {}) {
  const row = {
    followup_id: randomUUID(),
    case_id: caseRow.case_id,
    office_id: caseRow.office_id,
    kind: 'followup',
    due_date: '2026-11-12',
    channel: 'phone_call',
    status: 'pending',
    talking_point: '',
    outcome_note: '',
    completed_at: null,
    completed_by: null,
    source: 'manual',
    patient_responded: null,
    nurture_type: null,
    legacy_id: null,
    owner: 'alex.owner@carein.ai',
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
  db.table('tc_followups').push(row);
  return row;
}

/** A COMPLETE case through the real create route, so the aggregate parses. */
async function mkCase(app, { status: st = 'pending_tc', office = 'roland', patientName } = {}) {
  const r = await api(app.baseUrl, 'POST', `/api/tc/cases?office=${office}`, {
    patientName: patientName || (office === 'valley' ? 'Stedi TestValley' : 'Test 2, Stedi'),
    category: 'single_tooth',
    status: st,
    urgency: 'medium',
    caseValueCents: 120000,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return app.db.table('tc_cases').find((c) => c.case_id === r.body.case.caseId);
}

const status = (baseUrl, caseId, body, office = 'roland') =>
  api(baseUrl, 'POST', `/api/tc/cases/${caseId}/status?office=${office}`, body);
const nextTouchView = (baseUrl, office = 'roland') => api(baseUrl, 'GET', `/api/tc/followups/next-touch?office=${office}`);
const followupsOf = (db, caseId) => db.table('tc_followups').filter((f) => f.case_id === caseId);
const writesSince = (db, start) =>
  db.log
    .slice(start)
    .map((l) => l.sql)
    .filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s));

// ── The open-status list ────────────────────────────────────────────────────

test('open statuses are exactly the contract working statuses: no terminal one, and not scheduled', () => {
  assert.deepEqual(
    [...contract.OPEN_CASE_STATUSES],
    ['hygiene_review', 'diagnosed', 'pending_tc', 'pending_pt', 'presented', 'considering', 'financing_pending', 'nurture']
  );
  for (const s of contract.TERMINAL_CASE_STATUSES) assert.equal(contract.isOpenCaseStatus(s), false, s);
  assert.equal(contract.isOpenCaseStatus('scheduled'), false);
  for (const s of contract.OPEN_CASE_STATUSES) assert.equal(contract.isOpenCaseStatus(s), true, s);
  // No vocabulary added: the partition still covers CaseStatus exactly.
  assert.equal(
    contract.OPEN_CASE_STATUSES.length + contract.TERMINAL_CASE_STATUSES.length,
    contract.CaseStatus.options.length
  );
});

// ── The derivation ──────────────────────────────────────────────────────────

test('next touch = the earliest PENDING follow-up; completed/skipped never count; ties are stable', () => {
  const f = (followupId, dueDate, s = 'pending') => ({ followupId, dueDate, status: s });
  assert.equal(contract.pickNextTouch([]), null);
  assert.equal(contract.pickNextTouch([f('a', '2026-11-01', 'completed'), f('b', '2026-11-02', 'skipped')]), null);
  assert.equal(
    contract.pickNextTouch([f('c', '2026-11-20'), f('a', '2026-11-01', 'completed'), f('b', '2026-11-15')]).followupId,
    'b'
  );
  const tie = [f('zz', '2026-11-15'), f('aa', '2026-11-15')];
  assert.equal(contract.pickNextTouch(tie).followupId, 'aa');
  assert.equal(contract.pickNextTouch([...tie].reverse()).followupId, 'aa');

  const byCase = contract.nextTouchByCase([
    { ...f('x2', '2026-11-30'), caseId: 'X' },
    { ...f('y1', '2026-11-05', 'completed'), caseId: 'Y' },
    { ...f('x1', '2026-11-10'), caseId: 'X' },
  ]);
  assert.equal(byCase.get('X').followupId, 'x1');
  assert.equal(byCase.has('Y'), false);
});

test('chip state: overdue / today / upcoming; +2 business days skips the weekend; owner initials', () => {
  assert.equal(contract.nextTouchState('2026-11-10', '2026-11-11'), 'overdue');
  assert.equal(contract.nextTouchState('2026-11-11', '2026-11-11'), 'today');
  assert.equal(contract.nextTouchState('2026-11-12', '2026-11-11'), 'upcoming');
  assert.equal(contract.defaultNextTouchDate('2026-11-11'), '2026-11-13'); // Wed → Fri
  assert.equal(contract.defaultNextTouchDate('2026-11-13'), '2026-11-17'); // Fri → Tue
  assert.equal(contract.defaultNextTouchDate('2026-11-14'), '2026-11-17'); // Sat → Tue
  assert.equal(contract.ownerInitials('alex.owner@carein.ai'), 'AO');
  assert.equal(contract.ownerInitials('Alex Owner'), 'AO');
  assert.equal(contract.ownerInitials('tc@carein.ai'), 'TC');
  assert.equal(contract.ownerInitials(null), '?');
});

// ── The human status route ──────────────────────────────────────────────────

test('moving INTO an open status with no pending follow-up and no nextTouch: 409, nothing written', async (t) => {
  const app = await boot(t);
  const c = await mkCase(app, { status: 'diagnosed' });
  const start = app.db.log.length;

  const r = await status(app.baseUrl, c.case_id, { status: 'presented' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.success, false);
  assert.equal(r.body.code, 'NEXT_TOUCH_REQUIRED');
  assert.deepEqual(writesSince(app.db, start), []);
  assert.equal(c.status, 'diagnosed');
});

test('with nextTouch: the status moves AND one pending follow-up with that date + owner is written, office-stamped', async (t) => {
  const app = await boot(t);
  const c = await mkCase(app, { status: 'diagnosed' });

  const r = await status(app.baseUrl, c.case_id, {
    status: 'considering',
    nextTouch: { dueDate: '2026-11-13', owner: 'alex.owner@carein.ai' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.changed, true);
  assert.equal(r.body.case.status, 'considering');

  const rows = followupsOf(app.db, c.case_id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].due_date, '2026-11-13');
  assert.equal(rows[0].owner, 'alex.owner@carein.ai');
  assert.equal(rows[0].channel, 'phone_call', 'channel defaults to a call');
  assert.equal(rows[0].office_id, 'roland', 'office server-derived');
  assert.equal(rows[0].kind, 'followup');
  // The aggregate carries it, owner included, so the case view shows it at once.
  const fu = r.body.case.followups.find((f) => f.followupId === rows[0].followup_id);
  assert.equal(fu.owner, 'alex.owner@carein.ai');
  assert.ok(auditRows(app.db).some((a) => a.resource_type === 'tc_followup' && a.action === 'CREATE'));
});

test('a pending follow-up already in place satisfies the requirement: no nextTouch needed, none written', async (t) => {
  const app = await boot(t);
  const c = await mkCase(app, { status: 'diagnosed' });
  seedFollowup(app.db, c);

  const r = await status(app.baseUrl, c.case_id, { status: 'presented' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(followupsOf(app.db, c.case_id).length, 1);
});

test('a completed follow-up does NOT satisfy it: only a pending one counts', async (t) => {
  const app = await boot(t);
  const c = await mkCase(app, { status: 'diagnosed' });
  seedFollowup(app.db, c, { status: 'completed', completed_at: new Date() });

  const r = await status(app.baseUrl, c.case_id, { status: 'presented' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NEXT_TOUCH_REQUIRED');
});

test('terminal moves never need a next touch; nextTouch on a terminal or same-status move is a 400', async (t) => {
  const app = await boot(t);
  for (const s of contract.TERMINAL_CASE_STATUSES) {
    const c = await mkCase(app, { status: 'presented' });
    const body = s === 'lost' ? { status: s, lostReason: 'moved' } : { status: s };
    const r = await status(app.baseUrl, c.case_id, body);
    assert.equal(r.status, 200, `${s}: ${JSON.stringify(r.body)}`);
  }

  const c = await mkCase(app, { status: 'presented' });
  const terminal = await status(app.baseUrl, c.case_id, {
    status: 'scheduled',
    nextTouch: { dueDate: '2026-11-13', owner: ACTOR },
  });
  assert.equal(terminal.status, 400);
  assert.equal(terminal.body.code, 'NEXT_TOUCH_INVALID');

  const same = await status(app.baseUrl, c.case_id, {
    status: 'presented',
    nextTouch: { dueDate: '2026-11-13', owner: ACTOR },
  });
  assert.equal(same.status, 400);
  assert.equal(same.body.code, 'NEXT_TOUCH_INVALID');
  assert.equal(followupsOf(app.db, c.case_id).length, 0);
});

test('nextTouch must name a date and an owner (blank owner / bad date / extra field = 400)', async (t) => {
  const app = await boot(t);
  const c = await mkCase(app, { status: 'diagnosed' });
  for (const nextTouch of [
    { dueDate: '2026-11-13', owner: '   ' },
    { dueDate: '11/13/2026', owner: ACTOR },
    { dueDate: '2026-11-13' },
    { dueDate: '2026-11-13', owner: ACTOR, officeId: 'valley' },
  ]) {
    const r = await status(app.baseUrl, c.case_id, { status: 'presented', nextTouch });
    assert.equal(r.status, 400, JSON.stringify(nextTouch));
  }
  assert.equal(c.status, 'diagnosed');
});

test('same-status note saves still need no next touch (the dialog note path is untouched)', async (t) => {
  const app = await boot(t);
  const c = await mkCase(app, { status: 'presented' });
  const r = await status(app.baseUrl, c.case_id, { status: 'presented', note: 'Left a voicemail' });
  assert.equal(r.status, 200);
  assert.equal(r.body.noteAdded, true);
});

// ── System transitions: never blocked, left flagged ─────────────────────────

test('the shared applyStatusChange (what checkout routing runs) is never blocked by the requirement', async () => {
  const { FakeTenantDb } = require('./tcTestUtils');
  const db = new FakeTenantDb();
  const c = seedCase(db, { status: 'diagnosed' });
  const out = await caseStatus.applyStatusChange(db, {
    office: 'roland',
    caseId: c.case_id,
    status: 'considering',
    lostReason: null,
    note: 'Routed from checkout',
    actor: ACTOR,
    now: '2026-11-11T16:00:00.000Z',
  });
  assert.equal(out.unchanged, false);
  assert.equal(c.status, 'considering');
});

test('the requirement lives ONLY in the human route: the system writers never reference it', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
  assert.match(read('cases.js'), /NEXT_TOUCH_REQUIRED/);
  for (const p of ['caseStatus.js', 'checkoutRouting.js', 'checkout.js', 'nurture.js', '../../services/tcNurture/hooks.js']) {
    assert.doesNotMatch(read(p), /NEXT_TOUCH_REQUIRED|hasPendingFollowup/, p);
  }
});

test('a system move into an open status with no follow-up lands the case in "No next step"', async (t) => {
  const app = await boot(t);
  const c = seedCase(app.db, { status: 'diagnosed' });
  await caseStatus.applyStatusChange(app.db, {
    office: 'roland',
    caseId: c.case_id,
    status: 'considering',
    lostReason: null,
    note: 'OD pipeline sync',
    actor: 'system',
    now: '2026-11-11T16:00:00.000Z',
  });
  const v = await nextTouchView(app.baseUrl);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.deepEqual(v.body.noNextStep.map((x) => x.case_id), [c.case_id]);
  assert.equal(v.body.noNextStep[0].case_status, 'considering');
  assert.deepEqual(v.body.touches, []);
});

// ── GET /followups/next-touch: one touch per open case + the flagged ────────

test('the next-touch view: earliest pending per open case, date-sorted; "No next step" holds the rest; terminal excluded', async (t) => {
  const app = await boot(t);
  const a = seedCase(app.db, { patient_name: 'Test, Alpha', status: 'considering' });
  seedFollowup(app.db, a, { due_date: '2026-11-20' });
  const aFirst = seedFollowup(app.db, a, { due_date: '2026-11-14' });
  seedFollowup(app.db, a, { due_date: '2026-11-01', status: 'completed' });

  const b = seedCase(app.db, { patient_name: 'Test, Bravo', status: 'nurture' });
  const bOnly = seedFollowup(app.db, b, { due_date: '2026-11-09', kind: 'nurture', nurture_type: 'check_in', owner: null });

  const none = seedCase(app.db, { patient_name: 'Test, Charlie', status: 'presented' });
  const onlyDone = seedCase(app.db, { patient_name: 'Test, Delta', status: 'pending_tc' });
  seedFollowup(app.db, onlyDone, { status: 'skipped' });

  const terminal = seedCase(app.db, { patient_name: 'Test, Echo', status: 'scheduled' });
  seedFollowup(app.db, terminal, { due_date: '2026-11-02' });
  seedCase(app.db, { patient_name: 'Test, Foxtrot', status: 'lost' });

  const r = await nextTouchView(app.baseUrl);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(
    r.body.touches.map((x) => [x.case_id, x.followup_id]),
    [
      [b.case_id, bOnly.followup_id],
      [a.case_id, aFirst.followup_id],
    ],
    'exactly one touch per open case, earliest first'
  );
  assert.equal(r.body.touches[0].owner, null, 'a legacy row without an owner stays null, never guessed');
  assert.equal(r.body.touches[1].owner, 'alex.owner@carein.ai');
  assert.equal(r.body.touches[1].patient_name, 'Test, Alpha');
  assert.deepEqual(
    r.body.noNextStep.map((x) => x.case_id).sort(),
    [none.case_id, onlyDone.case_id].sort(),
    'open cases with no PENDING follow-up, and only those'
  );
  const everyId = [...r.body.touches.map((x) => x.case_id), ...r.body.noNextStep.map((x) => x.case_id)];
  assert.equal(new Set(everyId).size, everyId.length, 'no case is listed twice');
  assert.ok(!everyId.includes(terminal.case_id), 'a scheduled case is not open work');
});

test('the case list carries each card its next touch (earliest pending), or null', async (t) => {
  const app = await boot(t);
  const a = seedCase(app.db, { status: 'considering' });
  seedFollowup(app.db, a, { due_date: '2026-11-20' });
  const first = seedFollowup(app.db, a, { due_date: '2026-11-15', owner: 'alex.owner@carein.ai' });
  const b = seedCase(app.db, { status: 'presented' });

  const r = await api(app.baseUrl, 'GET', '/api/tc/cases?office=roland');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const byId = new Map(r.body.cases.map((c) => [c.caseId, c]));
  assert.deepEqual(byId.get(a.case_id).nextTouch, {
    followupId: first.followup_id,
    dueDate: '2026-11-15',
    owner: 'alex.owner@carein.ai',
    channel: 'phone_call',
    kind: 'followup',
  });
  assert.equal(byId.get(b.case_id).nextTouch, null);
});

// ── Completing / skipping the last pending touch ────────────────────────────

test('completing the LAST pending touch on an open case answers nextTouchNeeded: true; otherwise false', async (t) => {
  const app = await boot(t);
  const c = seedCase(app.db, { status: 'considering' });
  const one = seedFollowup(app.db, c, { due_date: '2026-11-10' });
  const two = seedFollowup(app.db, c, { due_date: '2026-11-12' });

  const first = await api(app.baseUrl, 'POST', `/api/tc/followups/${one.followup_id}/complete?office=roland`, {});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.nextTouchNeeded, false, 'another pending touch remains');

  const last = await api(app.baseUrl, 'POST', `/api/tc/followups/${two.followup_id}/skip?office=roland`, {});
  assert.equal(last.status, 200);
  assert.equal(last.body.nextTouchNeeded, true, 'nothing left: prompt for the next one');
  assert.equal(last.body.followup.status, 'skipped');
});

test('completing the last touch on a TERMINAL case asks for nothing', async (t) => {
  const app = await boot(t);
  const c = seedCase(app.db, { status: 'scheduled' });
  const only = seedFollowup(app.db, c);
  const r = await api(app.baseUrl, 'POST', `/api/tc/followups/${only.followup_id}/complete?office=roland`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.nextTouchNeeded, false);
});

test('a person-created follow-up has an owner: the one named, else the creator', async (t) => {
  const app = await boot(t);
  const c = seedCase(app.db);
  const base = { caseId: c.case_id, kind: 'followup', dueDate: '2026-11-13', channel: 'phone_call', talkingPoint: '' };

  const mine = await api(app.baseUrl, 'POST', '/api/tc/followups?office=roland', base);
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.equal(mine.body.followup.owner, ACTOR);

  const theirs = await api(app.baseUrl, 'POST', '/api/tc/followups?office=roland', { ...base, owner: 'alex.owner@carein.ai' });
  assert.equal(theirs.status, 201);
  assert.equal(theirs.body.followup.owner, 'alex.owner@carein.ai');
});

// ── Cross-office isolation ──────────────────────────────────────────────────

test('cross-office: valley cases and touches never appear in roland, and a roland call cannot touch a valley case', async (t) => {
  const app = await boot(t);
  const r = await mkCase(app, { status: 'considering' });
  const rTouch = seedFollowup(app.db, r, { due_date: '2026-11-20' });
  const v = await mkCase(app, { office: 'valley', status: 'considering' });
  // A valley follow-up wrongly pointing at the ROLAND case id must not count.
  seedFollowup(app.db, r, { office_id: 'valley', due_date: '2026-11-01' });
  const vNone = await mkCase(app, { office: 'valley', status: 'presented' });

  const roland = await nextTouchView(app.baseUrl, 'roland');
  assert.deepEqual(roland.body.touches.map((x) => x.followup_id), [rTouch.followup_id]);
  assert.deepEqual(roland.body.noNextStep, []);

  const valley = await nextTouchView(app.baseUrl, 'valley');
  assert.deepEqual(valley.body.touches, []);
  assert.deepEqual(valley.body.noNextStep.map((x) => x.case_id).sort(), [v.case_id, vNone.case_id].sort());

  // The roland status route cannot reach a valley case (404), and writes nothing.
  const start = app.db.log.length;
  const cross = await status(app.baseUrl, v.case_id, {
    status: 'presented',
    nextTouch: { dueDate: '2026-11-13', owner: ACTOR },
  });
  assert.equal(cross.status, 404);
  assert.deepEqual(writesSince(app.db, start), []);

  // In its own office it works, and the touch is stamped valley.
  const own = await status(
    app.baseUrl,
    v.case_id,
    { status: 'presented', nextTouch: { dueDate: '2026-11-13', owner: ACTOR } },
    'valley'
  );
  assert.equal(own.status, 200, JSON.stringify(own.body));
  const written = followupsOf(app.db, v.case_id);
  assert.equal(written.length, 1);
  assert.equal(written[0].office_id, 'valley');
});
