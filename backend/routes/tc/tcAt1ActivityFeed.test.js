'use strict';

/**
 * AT-1: GET /api/tc/cases/:caseId/activity — the merged, keyset-paged feed.
 *
 * Pins: a cross-office case 404s before ANY source is queried; keyset paging
 * is stable while rows are inserted between pages; each source's mapping
 * (including the objection orphan event, the pre-AT-0 referral send honesty
 * label, skipped-vs-completed follow-ups, and voice office mismatch dropped);
 * one READ audit row per page and a failed audit write is a 500; scope=patient
 * adds PatNum-linked items that scope=case leaves out.
 *
 * Read-only: the only write any request here makes is the audit row.
 *
 * Synthetic data only: roland 12827 "Test 2, Stedi" is the fixture patient.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { bootTcApp, api, auditRows } = require('./tcTestUtils');
const unifiedCallStore = require('../../services/unifiedCallStore');

const PATNUM = 12827;
const ACTIVITY = (caseId, qs = '', office = 'roland') => `/api/tc/cases/${caseId}/activity?office=${office}${qs}`;
const iso = (s) => new Date(s).toISOString();

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

function seedCase(db, overrides = {}) {
  const row = {
    case_id: randomUUID(),
    office_id: 'roland',
    patient_name: 'Test 2, Stedi',
    phone: '479-555-0100',
    email: 'stedi.test@example.com',
    od_patient_id: PATNUM,
    notes: '',
    status: 'pending_tc',
    updated_at: iso('2026-11-01T12:00:00Z'),
    ...overrides,
  };
  db.table('tc_cases').push(row);
  return row;
}

function seedEvent(db, c, overrides = {}) {
  const row = {
    event_id: randomUUID(),
    case_id: c.case_id,
    office_id: c.office_id,
    ts: iso('2026-11-02T12:00:00Z'),
    type: 'note_added',
    description: 'A note',
    actor: 'tc@carein.ai',
    detail: null,
    source_call_id: null,
    ...overrides,
  };
  db.table('tc_case_events').push(row);
  return row;
}

async function feed(baseUrl, caseId, qs = '') {
  const r = await api(baseUrl, 'GET', ACTIVITY(caseId, qs));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

/** Every item obeys the wire shape. */
function assertShape(it) {
  assert.match(it.id, /^[a-z_]+:.+/);
  assert.equal(it.id.split(':')[0], it.source);
  assert.ok(
    [
      'case_event', 'case_notes', 'objection', 'followup', 'hygiene_intake', 'checkout', 'message',
      'email_log', 'referral_event', 'preauth', 'voice_call', 'consent',
    ].includes(it.source),
    it.source
  );
  assert.equal(typeof it.kind, 'string');
  assert.equal(new Date(it.at).toISOString(), it.at);
  assert.equal(typeof it.actor.display, 'string');
  assert.ok(it.actor.email === null || typeof it.actor.email === 'string');
  assert.equal(typeof it.actor.system, 'boolean');
  assert.ok(['internal', 'patient_facing', 'external'].includes(it.audience));
  assert.equal(typeof it.title, 'string');
  assert.ok(it.body === null || typeof it.body === 'string');
  assert.ok(['case', 'patient'].includes(it.scope));
  assert.equal(typeof it.links, 'object');
  assert.equal(typeof it.chart.onChart, 'boolean');
  assert.ok(['full', 'current_value_only'].includes(it.completeness));
  assert.equal(it.rowId, undefined);
  assert.equal(it.alwaysShow, undefined);
}

/** Read every page; returns the concatenated items. */
async function readAll(baseUrl, caseId, { limit, qs = '', between } = {}) {
  const all = [];
  let cursor = null;
  for (let i = 0; i < 50; i += 1) {
    const q = `&limit=${limit}${qs}${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`;
    const body = await feed(baseUrl, caseId, q);
    body.items.forEach(assertShape);
    all.push(...body.items);
    if (!body.nextCursor) return all;
    cursor = body.nextCursor;
    if (between) between(i);
  }
  throw new Error('did not terminate');
}

// ── office / 404 ────────────────────────────────────────────────────────────

test('a case in another office is a 404 and no source is queried (and nothing is audited)', async (t) => {
  const { baseUrl, db } = await boot(t);
  const valley = seedCase(db, { office_id: 'valley' });
  seedEvent(db, valley);

  const start = db.log.length;
  const r = await api(baseUrl, 'GET', ACTIVITY(valley.case_id));
  assert.equal(r.status, 404);
  const touched = db.log.slice(start).map((l) => l.sql).filter((s) => /^SELECT/.test(s));
  assert.equal(touched.length, 1, `only the header read: ${JSON.stringify(touched)}`);
  assert.match(touched[0], /FROM tc_cases WHERE office_id = \$1 AND case_id = \$2$/);
  assert.equal(db.log.slice(start)[0].params[0], 'roland', 'the header read is keyed on req.tcOffice');
  assert.equal(auditRows(db).length, 0);
});

test('a malformed cursor or limit is a 400', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  assert.equal((await api(baseUrl, 'GET', ACTIVITY(c.case_id, '&before=not-a-cursor'))).status, 400);
  assert.equal((await api(baseUrl, 'GET', ACTIVITY(c.case_id, '&limit=201'))).status, 400);
  assert.equal((await api(baseUrl, 'GET', ACTIVITY(c.case_id, '&scope=everyone'))).status, 400);
});

// ── audit ───────────────────────────────────────────────────────────────────

test('one READ audit row per page (resource tc_case_activity); a failed audit write is a 500', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  for (let i = 0; i < 3; i += 1) seedEvent(db, c, { ts: iso(`2026-11-0${i + 2}T12:00:00Z`) });

  const before = auditRows(db).length;
  const pages = [];
  let cursor = null;
  do {
    const body = await feed(baseUrl, c.case_id, `&limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
    pages.push(body);
    cursor = body.nextCursor;
  } while (cursor);
  assert.equal(pages.length, 2);
  const rows = auditRows(db).slice(before);
  assert.equal(rows.length, 2, 'one per page');
  for (const a of rows) {
    assert.equal(a.action, 'READ');
    assert.equal(a.resource_type, 'tc_case_activity');
    assert.equal(a.resource_id, c.case_id);
  }

  // Writes: the audit row is the ONLY one.
  const writes = db.log.map((l) => l.sql).filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s));
  assert.ok(writes.every((s) => /^INSERT INTO audit_log/.test(s)), JSON.stringify(writes));

  db.onQuery(/^INSERT INTO audit_log/, () => {
    throw new Error('audit down');
  });
  const r = await api(baseUrl, 'GET', ACTIVITY(c.case_id));
  assert.equal(r.status, 500, 'PHI is not served without its audit row');
});

// ── keyset pagination ───────────────────────────────────────────────────────

test('keyset paging is stable while rows are inserted between pages: no gap, no duplicate, ties broken by id', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db, { notes: 'Current box text', updated_at: iso('2026-11-05T12:00:00Z') });
  // Three rows share one instant across two sources (an event and the notes box).
  const tie = iso('2026-11-05T12:00:00Z');
  const original = [
    seedEvent(db, c, { ts: tie }),
    seedEvent(db, c, { ts: tie }),
    seedEvent(db, c, { ts: iso('2026-11-04T12:00:00Z') }),
    seedEvent(db, c, { ts: iso('2026-11-03T12:00:00Z') }),
    seedEvent(db, c, { ts: iso('2026-11-02T12:00:00Z') }),
    seedEvent(db, c, { ts: iso('2026-11-01T12:00:00Z') }),
  ];
  const expectedFirstRead = await readAll(baseUrl, c.case_id, { limit: 100 });
  assert.equal(expectedFirstRead.length, 7);

  let n = 0;
  const paged = await readAll(baseUrl, c.case_id, {
    limit: 2,
    between: () => {
      // A newer row arrives between every page — it must not shift what follows.
      n += 1;
      seedEvent(db, c, { ts: iso(`2026-11-2${n}T12:00:00Z`), description: `late ${n}` });
    },
  });
  const ids = paged.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate');
  assert.deepEqual(ids, expectedFirstRead.map((i) => i.id), 'the same items, in the same order, none skipped');
  assert.ok(paged.every((i) => !/^late/.test(i.body || '')), 'inserts land above the cursor');
  // Order is (at DESC, id DESC).
  for (let i = 1; i < paged.length; i += 1) {
    const [a, b] = [paged[i - 1], paged[i]];
    assert.ok(a.at > b.at || (a.at === b.at && a.id > b.id), `${a.id} before ${b.id}`);
  }
  assert.equal(original.length, 6);
});

test('many rows sharing ONE instant page out completely (the tie-break widens instead of ending the source)', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const same = iso('2026-11-05T12:00:00Z');
  for (let i = 0; i < 9; i += 1) seedEvent(db, c, { ts: same });
  seedEvent(db, c, { ts: iso('2026-11-01T12:00:00Z') });
  const paged = await readAll(baseUrl, c.case_id, { limit: 2 });
  assert.equal(paged.length, 10);
  assert.equal(new Set(paged.map((i) => i.id)).size, 10);
  assert.equal(paged[9].at, iso('2026-11-01T12:00:00Z'));
});

test('each SQL source asks for at-or-before the cursor, newest first, with a bounded LIMIT', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  for (let i = 0; i < 4; i += 1) seedEvent(db, c, { ts: iso(`2026-11-0${i + 1}T12:00:00Z`) });
  const first = await feed(baseUrl, c.case_id, '&limit=2');
  const start = db.log.length;
  await feed(baseUrl, c.case_id, `&limit=2&before=${encodeURIComponent(first.nextCursor)}`);
  const q = db.log.slice(start).find((l) => /FROM tc_case_events WHERE office_id = \$1 AND case_id = ANY\(\$2\) AND ts <= \$3/.test(l.sql));
  assert.ok(q, 'keyset predicate on the event source');
  assert.match(q.sql, /ORDER BY ts DESC, event_id DESC LIMIT 3$/);
  assert.equal(q.params[0], 'roland');
  assert.ok(!db.log.some((l) => /SELECT \*/.test(l.sql)), 'no SELECT *');
});

// ── per-source mapping ──────────────────────────────────────────────────────

test('case events: status_change splits its note out; notes_updated is full history; the notes box is current value only', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db, { notes: 'Box as it is now', updated_at: iso('2026-11-09T12:00:00Z') });
  seedEvent(db, c, { type: 'status_change', description: 'pending_tc → presented: Walked through the plan', ts: iso('2026-11-03T12:00:00Z') });
  seedEvent(db, c, { type: 'status_change', description: 'presented → considering', ts: iso('2026-11-04T12:00:00Z') });
  seedEvent(db, c, { type: 'notes_updated', description: 'Case notes edited', detail: { notes: 'Version two' }, ts: iso('2026-11-05T12:00:00Z') });
  seedEvent(db, c, { type: 'notes_updated', description: 'Case notes cleared', detail: { notes: '' }, ts: iso('2026-11-06T12:00:00Z') });

  const { items } = await feed(baseUrl, c.case_id);
  const s1 = items.find((i) => i.title === 'Status: pending_tc → presented');
  assert.equal(s1.kind, 'status_change');
  assert.equal(s1.body, 'Walked through the plan');
  assert.equal(items.find((i) => i.title === 'Status: presented → considering').body, null);

  const rev = items.filter((i) => i.kind === 'notes_revision');
  assert.deepEqual(rev.map((i) => [i.title, i.body, i.completeness]), [
    ['Case notes cleared', null, 'full'],
    ['Case notes edited', 'Version two', 'full'],
  ]);

  const box = items.find((i) => i.source === 'case_notes');
  assert.equal(box.completeness, 'current_value_only');
  assert.equal(box.body, 'Box as it is now');
  assert.equal(box.at, iso('2026-11-09T12:00:00Z'));
  assert.equal(box.actor.email, null, 'pre-AT-0 saves had no actor');
  assert.equal(box.audience, 'internal');
});

test('objections: rows are emitted; a logged event with no surviving row is "objection (since removed)"; a matched event is not doubled', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const t1 = iso('2026-11-03T12:00:00Z');
  db.table('tc_case_objections').push({
    objection_id: randomUUID(),
    case_id: c.case_id,
    office_id: 'roland',
    category: 'cost',
    note: 'Wants to phase it',
    patient_words: 'That is more than I expected',
    logged_at: t1,
    created_at: t1,
  });
  seedEvent(db, c, { type: 'objection_logged', description: 'Objection logged: cost', ts: iso('2026-11-03T12:00:01Z') });
  seedEvent(db, c, { type: 'objection_logged', description: 'Objection logged: timing', ts: iso('2026-11-02T12:00:00Z') });

  const { items } = await feed(baseUrl, c.case_id);
  const objections = items.filter((i) => i.kind === 'objection');
  assert.equal(objections.length, 2, 'the row + the orphan, not the matched event');
  const row = objections.find((i) => i.source === 'objection');
  assert.equal(row.title, 'Objection: cost');
  assert.match(row.body, /Wants to phase it/);
  assert.match(row.body, /That is more than I expected/);
  const orphan = objections.find((i) => i.source === 'case_event');
  assert.equal(orphan.title, 'Objection (since removed)');
  assert.equal(orphan.body, 'timing');
});

test('follow-ups: a SKIPPED one is emitted; a COMPLETED one arrives only as its event (never twice)', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const base = { case_id: c.case_id, office_id: 'roland', kind: 'call', channel: 'call', talking_point: 'Check in' };
  db.table('tc_followups').push(
    { ...base, followup_id: randomUUID(), status: 'skipped', outcome_note: 'Patient asked us not to call', completed_at: iso('2026-11-04T12:00:00Z'), completed_by: 'tc@carein.ai' },
    { ...base, followup_id: randomUUID(), status: 'completed', outcome_note: 'Reached', completed_at: iso('2026-11-05T12:00:00Z'), completed_by: 'tc@carein.ai' },
    { ...base, followup_id: randomUUID(), status: 'pending', outcome_note: null, completed_at: null, completed_by: null }
  );
  seedEvent(db, c, { type: 'follow_up_completed', description: 'Follow-up completed: Reached', ts: iso('2026-11-05T12:00:00Z') });

  const { items } = await feed(baseUrl, c.case_id);
  assert.deepEqual(items.filter((i) => i.source === 'followup').map((i) => [i.kind, i.body]), [
    ['followup_skipped', 'Patient asked us not to call'],
  ]);
  const completed = items.filter((i) => i.kind === 'followup_completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].source, 'case_event');
  assert.equal(completed[0].body, 'Reached');
});

test('hygiene intake: one item at submitted_at; on chart when that visit has a Written hygiene write', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  db.table('tc_hygiene_intakes').push({
    intake_id: randomUUID(),
    case_id: c.case_id,
    office_id: 'roland',
    submitted_by: 'hyg@carein.ai',
    submitted_by_name: 'Hygiene User',
    submitted_at: iso('2026-11-03T15:00:00Z'),
    visit_date: '2026-11-03',
    chief_concern: 'Sensitivity upper left',
    hygienist_recommendation: 'Crown #14',
  });
  const visitId = randomUUID();
  db.table('hyg_visit').push({ visit_id: visitId, office: 'roland', pat_num: PATNUM, visit_date: '2026-11-03' });
  db.table('hyg_staged_write').push({ staged_write_id: randomUUID(), visit_id: visitId, office: 'roland', state: 'Written' });

  const { items } = await feed(baseUrl, c.case_id);
  const intake = items.find((i) => i.source === 'hygiene_intake');
  assert.equal(intake.at, iso('2026-11-03T15:00:00Z'));
  assert.equal(intake.body, 'Chief concern: Sensitivity upper left\nRecommendation: Crown #14');
  assert.equal(intake.actor.display, 'Hygiene User');
  assert.deepEqual(intake.chart, { onChart: true, via: 'hygiene' });
});

test('checkout: only nothing_needed, dismissed (with reason) and the reopened slot — other outcomes already arrive as events', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const base = { office_id: 'roland', od_patient_id: PATNUM, updated_at: iso('2026-11-06T12:00:00Z'), reopened_from: null, appointment_note: null };
  db.table('tc_checkout_handoffs').push(
    { ...base, handoff_id: randomUUID(), case_id: null, status: 'nothing_needed', outcome_by: 'tc@carein.ai', outcome_at: iso('2026-11-02T12:00:00Z') },
    { ...base, handoff_id: randomUUID(), case_id: null, status: 'dismissed', dismissed_reason: 'Duplicate card', dismissed_by: 'tc@carein.ai', dismissed_at: iso('2026-11-03T12:00:00Z') },
    { ...base, handoff_id: randomUUID(), case_id: c.case_id, status: 'scheduled', outcome_by: 'tc@carein.ai', outcome_at: iso('2026-11-04T12:00:00Z') },
    {
      ...base,
      handoff_id: randomUUID(),
      case_id: null,
      status: 'open',
      reopened_from: { outcome: 'not_scheduled', outcomeBy: 'tc@carein.ai', outcomeAt: iso('2026-11-04T09:00:00Z'), caseId: c.case_id, reopenedAt: iso('2026-11-05T12:00:00Z'), appointmentNote: 'Will call back' },
    },
    { ...base, handoff_id: randomUUID(), od_patient_id: 99999, case_id: null, status: 'nothing_needed', outcome_by: 'x', outcome_at: iso('2026-11-02T12:00:00Z') }
  );

  const { items } = await feed(baseUrl, c.case_id);
  const checkout = items.filter((i) => i.source === 'checkout');
  assert.deepEqual(checkout.map((i) => i.kind).sort(), ['checkout_dismissed', 'checkout_outcome', 'checkout_reopened']);
  assert.equal(checkout.find((i) => i.kind === 'checkout_dismissed').body, 'Duplicate card');
  const reopened = checkout.find((i) => i.kind === 'checkout_reopened');
  assert.match(reopened.title, /was: not scheduled/);
  assert.equal(reopened.at, iso('2026-11-05T12:00:00Z'));
});

test('messages: verbatim bodies with direction/channel; drafts, failed and skipped excluded; unlinked inbound from the case phone is flagged', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const base = { office_id: 'roland', case_id: c.case_id, channel: 'sms', subject: null, created_by: 'tc@carein.ai', sent_by: null, sent_at: null };
  db.table('tc_messages').push(
    { ...base, message_id: randomUUID(), direction: 'outbound', status: 'sent', body: 'Hi, this is the office.  Two spaces kept.', sent_by: 'tc@carein.ai', created_at: iso('2026-11-01T12:00:00Z'), sent_at: iso('2026-11-02T12:00:00Z') },
    { ...base, message_id: randomUUID(), direction: 'inbound', status: 'received', body: 'Thanks!', created_by: null, created_at: iso('2026-11-03T12:00:00Z') },
    { ...base, message_id: randomUUID(), direction: 'outbound', status: 'draft', body: 'DRAFT ONLY', created_at: iso('2026-11-04T12:00:00Z') },
    { ...base, message_id: randomUUID(), direction: 'outbound', status: 'failed', body: 'FAILED ONLY', created_at: iso('2026-11-04T12:00:00Z') },
    { ...base, message_id: randomUUID(), direction: 'outbound', status: 'skipped', body: 'SKIPPED ONLY', created_at: iso('2026-11-04T12:00:00Z') },
    { ...base, message_id: randomUUID(), case_id: null, direction: 'inbound', status: 'received', body: 'Is my appointment still on?', from_address: '+14795550100', created_by: null, created_at: iso('2026-11-05T12:00:00Z') },
    { ...base, message_id: randomUUID(), case_id: null, office_id: 'valley', direction: 'inbound', status: 'received', body: 'OTHER OFFICE', from_address: '+14795550100', created_by: null, created_at: iso('2026-11-05T12:00:00Z') }
  );

  const { items } = await feed(baseUrl, c.case_id);
  const msgs = items.filter((i) => i.source === 'message');
  assert.equal(msgs.length, 3, JSON.stringify(msgs.map((m) => m.body)));
  assert.ok(!msgs.some((m) => /ONLY|OTHER OFFICE/.test(m.body)));
  const out = msgs.find((m) => m.kind === 'sms_out');
  assert.equal(out.body, 'Hi, this is the office.  Two spaces kept.');
  assert.equal(out.at, iso('2026-11-02T12:00:00Z'), 'an outbound is placed when it went out');
  assert.equal(out.direction, 'outbound');
  assert.equal(out.audience, 'patient_facing');
  assert.equal(msgs.find((m) => m.kind === 'sms_in' && m.scope === 'case').body, 'Thanks!');
  const unlinked = msgs.find((m) => m.scope === 'patient');
  assert.match(unlinked.title, /not linked to this case/);
  assert.equal(unlinked.body, 'Is my appointment still on?');
});

test('tc_communications: subject only, never a body', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  db.table('tc_communications').push({
    comm_id: randomUUID(), office_id: 'roland', case_id: c.case_id, template_name: 'Treatment summary', sender: 'tc@carein.ai',
    sender_name: 'TC User', subject: 'Your treatment plan', status: 'sent', sent_at: iso('2026-11-02T12:00:00Z'),
  });
  const { items } = await feed(baseUrl, c.case_id);
  const e = items.find((i) => i.source === 'email_log');
  assert.equal(e.title, 'Your treatment plan');
  assert.equal(e.body, null);
  assert.equal(e.kind, 'email_out');
});

test('referral events: a snapshot send shows the letter as sent; a pre-AT-0 send is titled "letter as sent was not stored" and never re-rendered; chart notes are on chart', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const referralId = randomUUID();
  db.table('tc_referrals').push({
    referral_id: referralId, office_id: 'roland', od_patient_id: PATNUM, tc_case_id: c.case_id, specialty: 'endodontics',
    narrative: 'CURRENT NARRATIVE — EDITED AFTER SENDING', reason: 'CURRENT REASON',
  });
  const ev = (o) => ({
    event_id: randomUUID(), office_id: 'roland', referral_id: referralId, from_status: null, to_status: null, actor: 'tc@carein.ai',
    note: null, verb: null, recipient_address: null, correspondence_direction: null, correspondence_party: null, correspondence_channel: null,
    chart_note_milestone: null, chart_note_commlog_num: null, letter_snapshot: null, ...o,
  });
  db.table('tc_referral_events').push(
    ev({ verb: 'send', at: iso('2026-10-01T12:00:00Z') }),
    ev({
      verb: 'send', at: iso('2026-11-02T12:00:00Z'),
      letter_snapshot: { audience: 'specialist', subject: 'Referral: endodontics', text: 'Dear Doctor, the letter as sent.', withheld: ['date_of_birth', 'insurance'] },
    }),
    ev({ verb: 'correspondence', at: iso('2026-11-03T12:00:00Z'), note: 'Specialist called to confirm', correspondence_direction: 'from', correspondence_party: 'specialist', correspondence_channel: 'phone' }),
    ev({ verb: 'chart_note_written', at: iso('2026-11-04T12:00:00Z'), chart_note_milestone: 'sent', chart_note_commlog_num: 5551 })
  );

  const { items } = await feed(baseUrl, c.case_id);
  const ref = items.filter((i) => i.source === 'referral_event');
  const sent = ref.filter((i) => i.kind === 'referral_sent');
  assert.equal(sent.length, 2);
  const withSnap = sent.find((i) => i.at === iso('2026-11-02T12:00:00Z'));
  assert.equal(withSnap.audience, 'external');
  assert.match(withSnap.body, /Subject: Referral: endodontics/);
  assert.match(withSnap.body, /Dear Doctor, the letter as sent\./);
  assert.match(withSnap.body, /Not stored with this copy: date of birth, insurance/);
  const legacy = sent.find((i) => i.at === iso('2026-10-01T12:00:00Z'));
  assert.match(legacy.title, /letter as sent was not stored/);
  assert.ok(!JSON.stringify(ref).includes('CURRENT NARRATIVE'), 'current fields are never shown as the sent letter');
  assert.ok(!JSON.stringify(ref).includes('CURRENT REASON'));

  const corr = ref.find((i) => i.kind === 'correspondence');
  assert.equal(corr.direction, 'inbound');
  assert.match(corr.title, /from the specialist \(phone\)/);
  const chart = ref.find((i) => i.kind === 'chart_note');
  assert.deepEqual(chart.chart, { onChart: true, via: 'referral', commLogNum: 5551 });
  assert.ok(ref.every((i) => i.links.referralId === referralId));
});

test('pre-auths: one current-value item per pre-auth plus its history rows as full items', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  const preauthId = randomUUID();
  db.table('tc_preauth_cases').push({
    preauth_id: preauthId, office_id: 'roland', case_id: c.case_id, od_patient_id: PATNUM, preauth_type: 'crown', description: 'Crown #14',
    insurance_carrier: 'Test Dental Plan', status: 'submitted', reference_number: 'REF-1', notes: null, updated_at: iso('2026-11-06T12:00:00Z'),
  });
  const pe = (o) => ({ event_id: randomUUID(), office_id: 'roland', preauth_id: preauthId, actor: 'tc@carein.ai', ...o });
  db.table('tc_preauth_events').push(
    pe({ type: 'created', ts: iso('2026-11-02T12:00:00Z'), changes: { status: { from: null, to: 'draft' } } }),
    pe({ type: 'status_change', ts: iso('2026-11-05T12:00:00Z'), changes: { status: { from: 'draft', to: 'submitted' } } })
  );

  const { items } = await feed(baseUrl, c.case_id);
  const pa = items.filter((i) => i.source === 'preauth');
  const current = pa.find((i) => i.kind === 'preauth_current');
  assert.equal(current.completeness, 'current_value_only');
  assert.match(current.title, /current value/);
  assert.match(current.body, /Carrier: Test Dental Plan/);
  const changed = pa.find((i) => i.kind === 'preauth_status_change');
  assert.equal(changed.completeness, 'full');
  assert.equal(changed.body, 'status: draft → submitted');
  assert.equal(pa.find((i) => i.kind === 'preauth_created').body, 'status: draft');
  assert.ok(pa.every((i) => i.links.preauthId === preauthId));
});

test('consent: the current state only, labelled current value', async (t) => {
  const { baseUrl, db } = await boot(t);
  const c = seedCase(db);
  db.table('tc_contact_consent').push({
    consent_id: randomUUID(), office_id: 'roland', channel: 'sms', address: '+14795550100', state: 'opted_out', source: 'keyword', note: 'Replied STOP',
    updated_by: 'system:inbound', updated_at: iso('2026-11-04T12:00:00Z'),
  });
  const { items } = await feed(baseUrl, c.case_id);
  const k = items.find((i) => i.source === 'consent');
  assert.equal(k.title, 'Text consent: opted out (current value)');
  assert.equal(k.completeness, 'current_value_only');
  assert.equal(k.actor.system, true);
});

// ── voice ───────────────────────────────────────────────────────────────────

function withCalls(t, calls) {
  for (const c of calls) unifiedCallStore.calls.set(c.id, c);
  t.after(() => {
    for (const c of calls) unifiedCallStore.calls.delete(c.id);
  });
}

test('voice: only when entitled; linked by tc_case_id or a handoff event; an office mismatch is dropped silently; a pruned stub is a placeholder', async (t) => {
  const c0 = randomUUID();
  const ids = { linked: `at1-${randomUUID()}`, mismatch: `at1-${randomUUID()}`, stub: `at1-${randomUUID()}`, stubOther: `at1-${randomUUID()}` };
  withCalls(t, [
    // retell, no agent mapping ⇒ roland (the documented fallback)
    { id: ids.linked, source: 'retell', call_date: iso('2026-11-03T12:00:00Z'), duration_seconds: 125, summary: 'Asked about crown cost.', tc_case_id: c0, od_commlog_num: 777 },
    // mango on an unmapped line ⇒ 'unknown', never roland ⇒ dropped
    { id: ids.mismatch, source: 'mango', called_number: '+10000000000', call_date: iso('2026-11-04T12:00:00Z'), summary: 'MISMATCHED OFFICE', tc_case_id: c0 },
    { id: ids.stub, record_kind: 'stub', source: 'retell', office: 'roland', call_date: iso('2026-10-01T12:00:00Z'), pruned_at: iso('2026-11-01T00:00:00Z') },
    { id: ids.stubOther, record_kind: 'stub', source: 'mango', office: 'valley', call_date: iso('2026-10-02T12:00:00Z'), pruned_at: iso('2026-11-01T00:00:00Z') },
  ]);

  const run = async (modules) => {
    const app = await bootTcApp({ modules });
    t.after(() => app.close());
    const c = seedCase(app.db, { case_id: c0 });
    seedEvent(app.db, c, { type: 'voice_handoff', description: 'Sent to TC from a CareIN call', source_call_id: ids.stub, detail: { callUrl: null, callSummary: 'Summary kept on the handoff.', attached: false }, ts: iso('2026-10-01T12:05:00Z') });
    seedEvent(app.db, c, { type: 'voice_handoff', description: 'Sent to TC from a CareIN call', source_call_id: ids.stubOther, detail: null, ts: iso('2026-10-02T12:05:00Z') });
    return (await feed(app.baseUrl, c.case_id)).items;
  };

  const items = await run(['tc', 'voice']);
  const calls = items.filter((i) => i.source === 'voice_call');
  assert.deepEqual(calls.map((i) => i.links.callId).sort(), [ids.linked, ids.stub].sort());
  const live = calls.find((i) => i.links.callId === ids.linked);
  assert.equal(live.title, 'Phone call · 2 min');
  assert.equal(live.body, 'Asked about crown cost.');
  assert.deepEqual(live.chart, { onChart: true, via: 'voice', commLogNum: 777 });
  assert.equal(calls.find((i) => i.links.callId === ids.stub).title, 'Call record pruned; summary kept on handoff');
  assert.ok(!JSON.stringify(items).includes('MISMATCHED OFFICE'));
  // The handoff events show regardless, with the summary they kept.
  const handoffs = items.filter((i) => i.kind === 'voice_handoff');
  assert.equal(handoffs.length, 2);
  assert.ok(handoffs.some((h) => h.body === 'Summary kept on the handoff.'));

  const unentitled = await run(['tc']);
  assert.equal(unentitled.filter((i) => i.source === 'voice_call').length, 0, 'no voice module ⇒ no calls');
  assert.equal(unentitled.filter((i) => i.kind === 'voice_handoff').length, 2, 'the handoff event still shows');
});

// ── scope ───────────────────────────────────────────────────────────────────

test('scope=patient adds the same patient\'s PatNum-linked items (other cases, referrals, calls); scope=case leaves them out', async (t) => {
  const callId = `at1-${randomUUID()}`;
  withCalls(t, [
    { id: callId, source: 'retell', call_date: iso('2026-11-03T12:00:00Z'), summary: 'PatNum-linked call', od_patient_id: PATNUM, od_patient_office: 'roland' },
  ]);
  const { baseUrl, db } = await boot(t, { modules: ['tc', 'voice'] });
  const c = seedCase(db);
  const other = seedCase(db, { notes: '' });
  const foreign = seedCase(db, { office_id: 'valley' }); // same PatNum, other office: never joins
  seedEvent(db, c, { description: 'this case note', ts: iso('2026-11-02T12:00:00Z') });
  seedEvent(db, other, { description: 'other case note', ts: iso('2026-11-02T13:00:00Z') });
  seedEvent(db, foreign, { description: 'VALLEY NOTE', ts: iso('2026-11-02T14:00:00Z') });
  const refId = randomUUID();
  db.table('tc_referrals').push({ referral_id: refId, office_id: 'roland', od_patient_id: PATNUM, tc_case_id: null, specialty: 'oral surgery' });
  db.table('tc_referral_events').push({ event_id: randomUUID(), office_id: 'roland', referral_id: refId, verb: 'create', actor: 'tc@carein.ai', at: iso('2026-11-04T12:00:00Z'), from_status: null, to_status: 'draft', note: null, letter_snapshot: null });

  const caseItems = (await feed(baseUrl, c.case_id)).items;
  assert.ok(caseItems.every((i) => i.scope === 'case'));
  assert.ok(caseItems.some((i) => i.body === 'this case note'));
  assert.ok(!caseItems.some((i) => i.body === 'other case note'));
  assert.ok(!caseItems.some((i) => i.source === 'referral_event'));
  assert.ok(!caseItems.some((i) => i.source === 'voice_call'));

  const patientItems = (await feed(baseUrl, c.case_id, '&scope=patient')).items;
  const other1 = patientItems.find((i) => i.body === 'other case note');
  assert.equal(other1.scope, 'patient');
  assert.equal(patientItems.find((i) => i.body === 'this case note').scope, 'case');
  assert.equal(patientItems.find((i) => i.source === 'referral_event').scope, 'patient');
  assert.equal(patientItems.find((i) => i.source === 'voice_call').scope, 'patient');
  assert.ok(!JSON.stringify(patientItems).includes('VALLEY NOTE'), 'another office never joins, PatNum or not');
});
