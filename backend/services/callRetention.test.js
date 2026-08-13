'use strict';

/**
 * Retention: the stub shape, the cutoff, and the pruner.
 *
 * The single most important assertion in this file is the PHI one
 * (`toStub drops every content field`). A stub that leaked a caller name would
 * be worse than no retention at all — it would mean we told ourselves the data
 * was gone while a copy of it stayed in the store forever.
 *
 * No real patient data anywhere: every fixture below is synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const retention = require('./callRetention');

/**
 * A fully-populated live call, the way the store holds one after a human has
 * worked it end to end. Deliberately carries EVERY content field the stub is
 * supposed to drop.
 */
function workedCall(overrides = {}) {
  return {
    id: 'mango_call_9001',
    record_kind: 'call',
    source: 'mango',
    external_id: 'mango_call_9001',
    call_date: '2026-06-01T15:04:05.000Z',
    duration_seconds: 214,
    caller_number: '+15550100001',
    called_number: '+15550199999',
    caller_name: 'Synthetic Fixture',
    summary: 'Caller asked about a synthetic appointment.',
    transcript: 'Agent: hello\nUser: hi\n',
    transcript_json: [{ role: 'agent', speaker: null, content: 'hello', start: 0, end: 1 }],
    recording_url: 'https://example.invalid/recording.mp3',
    action_needed: 'Call back',
    callback_number: '+15550100001',
    triage_note: 'left a voicemail',
    od_patient_id: 12828,
    od_patient_name: 'Test, MangoTest',
    od_commlog_num: 344634,
    disposition: 'lab',
    disposition_by: { name: 'Front Desk', email: 'desk@example.invalid' },
    disposition_at: '2026-06-01T16:00:00.000Z',
    transcribed_by: { name: 'Front Desk', email: 'desk@example.invalid' },
    transcribed_at: '2026-06-01T15:30:00.000Z',
    sent_by: { name: 'Office Lead', email: 'lead@example.invalid' },
    sent_at: '2026-06-01T15:45:00.000Z',
    tc_sent_by: { name: 'Office Lead', email: 'lead@example.invalid' },
    tc_sent_at: '2026-06-01T15:50:00.000Z',
    tc_case_id: 'case_123',
    triage_by: { name: 'Front Desk', email: 'desk@example.invalid' },
    triage_at: '2026-06-01T15:20:00.000Z',
    resolved_by: { name: 'Front Desk', email: 'desk@example.invalid' },
    resolved_at: '2026-06-01T16:05:00.000Z',
    notes: [
      {
        id: 'note-1',
        text: 'Synthetic note body that must never survive pruning.',
        author: { name: 'Front Desk', email: 'desk@example.invalid' },
        created_at: '2026-06-01T15:35:00.000Z',
      },
    ],
    linked_call_id: 'call_retell_9001',
    link_role: 'duplicate_leg',
    ...overrides,
  };
}

// --- the stub shape --------------------------------------------------------

test('toStub keeps the identity a stub is for: id, kind, office, date', () => {
  const stub = retention.toStub(workedCall(), { now: new Date('2026-08-13T09:00:00.000Z') });

  assert.equal(stub.id, 'mango_call_9001');
  assert.equal(stub.record_kind, 'stub');
  assert.equal(stub.source, 'mango');
  assert.equal(stub.call_date, '2026-06-01T15:04:05.000Z');
  assert.equal(stub.pruned_at, '2026-08-13T09:00:00.000Z');
  // The office is FROZEN onto the stub at prune time. It has to be: it is derived
  // from called_number, which the stub drops — so a stub that stored the office
  // lazily could never answer "whose practice was this?" again.
  assert.equal(stub.office, 'unknown', 'an unmapped Mango line stubs as unknown');
});

test('toStub freezes the office a Retell call was attributed to', () => {
  const stub = retention.toStub(
    { id: 'call_r1', source: 'retell', handler_id: 'agent_3007741dd93381f51675417edb', call_date: '2026-06-01T15:04:05.000Z' },
    { now: new Date() }
  );

  assert.equal(stub.office, 'roland');
});

test('toStub drops every content field — a stub carries no PHI', () => {
  const stub = retention.toStub(workedCall(), { now: new Date() });

  // The fields that identify or describe the CALLER or the conversation.
  for (const banned of [
    'caller_name', 'caller_number', 'called_number', 'callback_number',
    'summary', 'transcript', 'transcript_json', 'recording_url', 'recording_path',
    'action_needed', 'triage_note', 'notes',
    'od_patient_name', 'od_patient_id', 'od_commlog_num',
    'call_reason', 'disposition',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(stub, banned),
      false,
      `stub must not carry '${banned}'`
    );
  }

  // Belt and braces: no value anywhere in the stub may contain the fixture's
  // caller name or number, however it got there.
  const serialized = JSON.stringify(stub);
  assert.equal(serialized.includes('Synthetic Fixture'), false);
  assert.equal(serialized.includes('5550100001'), false);
  assert.equal(serialized.includes('must never survive'), false);
});

test('toStub records the actions taken on the call, with actor and time', () => {
  const stub = retention.toStub(workedCall(), { now: new Date() });

  const byAction = new Map(stub.actions.map((a) => [a.action, a]));

  assert.deepEqual(
    [...byAction.keys()].sort(),
    ['dispositioned', 'note_added', 'resolved', 'sent_to_chart', 'sent_to_tc', 'transcribed', 'triaged']
  );
  assert.deepEqual(byAction.get('sent_to_chart'), {
    action: 'sent_to_chart',
    actor: { name: 'Office Lead', email: 'lead@example.invalid' },
    at: '2026-06-01T15:45:00.000Z',
  });
  // The note's TEXT is gone; that it was written, by whom and when, survives.
  assert.equal(byAction.get('note_added').at, '2026-06-01T15:35:00.000Z');
});

test('toStub of an untouched call records no actions rather than empty ones', () => {
  const stub = retention.toStub(
    { id: 'call_untouched', source: 'retell', call_date: '2026-06-01T15:04:05.000Z' },
    { now: new Date() }
  );

  assert.deepEqual(stub.actions, []);
});

test('toStub keeps twin linkage so a stub never points at nothing', () => {
  const stub = retention.toStub(workedCall(), { now: new Date() });

  assert.equal(stub.linked_call_id, 'call_retell_9001');
  assert.equal(stub.link_role, 'duplicate_leg');
});

test("the office resolver honours a stub's frozen office instead of re-deriving it", () => {
  // Every listed call gets `office_id: getOfficeForCall(call)` in routes/unifiedCalls.
  // A stub has no called_number and no handler_id, so re-deriving would send every
  // Mango stub to 'unknown' and every Retell stub to the Roland fallback — silently
  // reattributing pruned calls to the wrong practice in the office-filtered views.
  const { getOfficeForCall } = require('../config/officeAgents');

  const mangoStub = retention.toStub(
    { id: 'm1', source: 'mango', called_number: '+14797854390', call_date: '2026-06-01T15:04:05.000Z' },
    { now: new Date() }
  );
  const retellStub = retention.toStub(
    { id: 'r1', source: 'retell', handler_id: 'agent_3007741dd93381f51675417edb', call_date: '2026-06-01T15:04:05.000Z' },
    { now: new Date() }
  );

  assert.equal(mangoStub.office, 'valley', 'frozen at prune time from the mapped line');
  assert.equal(getOfficeForCall(mangoStub), 'valley', 'must NOT fall back to unknown');
  assert.equal(getOfficeForCall(retellStub), 'roland');
});

test('toStub is idempotent — stubbing a stub returns it unchanged', () => {
  const once = retention.toStub(workedCall(), { now: new Date('2026-08-13T09:00:00.000Z') });
  const twice = retention.toStub(once, { now: new Date('2026-09-01T09:00:00.000Z') });

  assert.deepEqual(twice, once, 'a second prune must not restamp pruned_at');
});

test('isStub tells a stub from a live record', () => {
  assert.equal(retention.isStub(retention.toStub(workedCall(), { now: new Date() })), true);
  assert.equal(retention.isStub(workedCall()), false);
  assert.equal(retention.isStub(null), false);
  assert.equal(retention.isStub(undefined), false);
});

// --- the cutoff ------------------------------------------------------------

test('cutoffFor is exactly retentionDays before now', () => {
  const now = new Date('2026-08-13T09:00:00.000Z');

  assert.equal(retention.cutoffFor(now, 30).toISOString(), '2026-07-14T09:00:00.000Z');
});

test('isPastRetention is false at 29 days and true at 31 — the boundary', () => {
  const now = new Date('2026-08-13T09:00:00.000Z');
  const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

  assert.equal(retention.isPastRetention({ call_date: daysAgo(29) }, now, 30), false);
  assert.equal(retention.isPastRetention({ call_date: daysAgo(31) }, now, 30), true);
});

test('isPastRetention treats an unparseable date as NOT past retention', () => {
  // Fail-safe direction: a garbage date must not cause a record to be pruned.
  // Losing a call because its timestamp was malformed is unrecoverable; keeping
  // one too long is not.
  const now = new Date('2026-08-13T09:00:00.000Z');

  assert.equal(retention.isPastRetention({ call_date: 'not-a-date' }, now, 30), false);
  assert.equal(retention.isPastRetention({}, now, 30), false);
});

test('retentionDays of 0 disables pruning entirely', () => {
  const now = new Date('2026-08-13T09:00:00.000Z');

  assert.equal(retention.isPastRetention({ call_date: '2020-01-01T00:00:00.000Z' }, now, 0), false);
});
