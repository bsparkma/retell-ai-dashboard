'use strict';

// Unit tests for the OD commlog write remediation (PRD §4).
// Runner: `node --test` (CI build-test gate). Asserts the real POST /commlogs contract:
// string Mode_/SentOrReceived enums, formatted CommDateTime, a configured CommType
// DefNum, and that createCommLog actually uses the API in api mode (the old webhook path
// silently no-opped without a DB pool). See docs/OD_API_CONTRACT.md §10.

const test = require('node:test');
const assert = require('node:assert/strict');

const sync = require('./openDentalSync');
const openDentalService = require('../config/openDental');

/**
 * A fake office-bound OD connection. Since the per-location slice every commlog
 * write takes one of these — there is no "default office" for a chart write — so
 * these tests name the office explicitly, exactly as production does.
 * @param {{officeKey?: string, officeName?: string, commTypeDefNum?: number, client?: object}} [over]
 */
function fakeOd(over = {}) {
  return {
    officeKey: over.officeKey || 'roland',
    officeName: over.officeName || 'Roland',
    commTypeDefNum: over.commTypeDefNum ?? 486,
    client: over.client || openDentalService,
  };
}

test('buildCommLogApiPayload maps DB-shaped entry to the real OD /commlogs contract', () => {
  const payload = sync.buildCommLogApiPayload(
    1001,
    {
      CommDateTime: '2026-06-04T15:30:00.000Z',
      Mode_: 3,            // DB int -> "Phone"
      SentOrReceived: 1,   // inbound -> "Received"
      Note: 'CareIN call summary',
      CommType: 2          // ignored on the API path; replaced by the OFFICE's DefNum
    },
    fakeOd()
  );

  assert.equal(payload.PatNum, 1001);
  assert.equal(payload.Note, 'CareIN call summary');
  assert.equal(payload.CommDateTime, '2026-06-04 15:30:00'); // no T/Z, OD format
  assert.equal(payload.Mode_, 'Phone');                      // string enum, not 3
  assert.equal(payload.SentOrReceived, 'Received');          // string enum, not 1
  assert.equal(typeof payload.Mode_, 'string');
  assert.equal(typeof payload.SentOrReceived, 'string');
  assert.equal(payload.CommType, 486);                       // Roland's "CareIN AI Call" DefNum
});

test("CommType comes from the OFFICE, so one practice's DefNum never reaches another", () => {
  // Verified live 2026-08-07: "CareIN AI Call" is DefNum 486 in Roland and 451 in
  // Riley/valley. 486 is not a CommLogType in Riley's database at all.
  const entry = { CommDateTime: '2026-06-04 15:30:00', Mode_: 3, SentOrReceived: 1, Note: 'x' };

  const roland = sync.buildCommLogApiPayload(1001, entry, fakeOd({ officeKey: 'roland', commTypeDefNum: 486 }));
  const valley = sync.buildCommLogApiPayload(7115, entry, fakeOd({ officeKey: 'valley', commTypeDefNum: 451 }));

  assert.equal(roland.CommType, 486);
  assert.equal(valley.CommType, 451);
  assert.notEqual(valley.CommType, 486);
});

test('createCommLog POSTs /commlogs with the API payload when in api mode', async () => {
  const calls = [];
  const client = {
    useDatabase: false,
    pool: null,
    client: {
      post: async (url, body) => { calls.push({ url, body }); return { data: { CommlogNum: 7777 } }; }
    },
    formatODDateTime: openDentalService.formatODDateTime.bind(openDentalService),
  };

  const result = await sync.createCommLog(
    1001,
    { CommDateTime: '2026-06-04 15:30:00', Mode_: 3, SentOrReceived: 1, Note: 'hi', CommType: 1 },
    fakeOd({ client })
  );
  assert.equal(result.success, true);
  assert.equal(result.commLogNum, 7777);
  assert.equal(calls[0].url, '/commlogs');
  assert.equal(calls[0].body.Mode_, 'Phone');
  assert.equal(calls[0].body.SentOrReceived, 'Received');
  assert.equal(calls[0].body.PatNum, 1001);
});

test('createCommLog reports failure (not a throw) when no OD connection is available', async () => {
  const client = { useDatabase: false, pool: null, client: null };
  const result = await sync.createCommLog(
    1001,
    { Note: 'x', CommDateTime: '2026-06-04 15:30:00' },
    fakeOd({ client })
  );
  assert.equal(result.success, false);
  assert.match(result.error, /No Open Dental connection/);
});

test('createCommLog refuses a write with no office connection at all', async () => {
  // There is no default practice for a chart note. A caller that cannot name the
  // office must be refused rather than allowed to guess.
  const result = await sync.createCommLog(1001, { Note: 'x', CommDateTime: '2026-06-04 15:30:00' });
  assert.equal(result.success, false);
  assert.match(result.error, /No Open Dental office connection/);
});

// ── Compact summary block (day-1 item 2) ─────────────────────────────────────

test('formatCommLogEntry: compact 4-field summary block (default contentType)', () => {
  const note = sync.formatCommLogEntry({
    id: 'x1', source: 'mango', call_date: '2026-07-23T19:30:00.000Z',
    transcript: 'Hi, this is Sam, I need to reschedule my cleaning.',
    caller_name: 'Sam Rivera', call_reason: 'Reschedule cleaning',
    action_needed: 'Call back to confirm Tue 2:30', callback_number: '4795551234',
  }, {}).Note;
  assert.match(note, /^CareIN call - .+ - Staff \(Mango\)$/m);
  assert.match(note, /^Caller: Sam Rivera$/m);
  assert.match(note, /^Reason: Reschedule cleaning$/m);
  assert.match(note, /^Action: Call back to confirm Tue 2:30$/m);
  assert.match(note, /^Callback #: 4795551234$/m);
  // Compact: no full transcript unless requested.
  assert.ok(!/Full transcript/.test(note));
});

test('formatCommLogEntry: emergency marker + callback fallbacks', () => {
  // No explicit callback_number, but callback_required → falls back to caller_number.
  const note = sync.formatCommLogEntry({
    id: 'x2', source: 'mango', call_date: '2026-07-23T19:30:00.000Z',
    transcript: 'I broke my tooth and it really hurts.',
    caller_name: 'Pat', call_reason: 'Broken tooth', is_emergency: true,
    callback_required: true, caller_number: '9185550000',
  }, {}).Note;
  assert.match(note, /^Reason: Broken tooth \[EMERGENCY\]$/m);
  assert.match(note, /^Callback #: 9185550000$/m);

  // Nothing to call back on → dash.
  const note2 = sync.formatCommLogEntry({
    id: 'x3', source: 'mango', call_date: '2026-07-23T19:30:00.000Z',
    transcript: 'General question about hours.',
  }, {}).Note;
  assert.match(note2, /^Callback #: -$/m);
  assert.match(note2, /^Caller: Unknown$/m);
});

test('formatCommLogEntry: contentType "transcript" appends the full transcript', () => {
  const note = sync.formatCommLogEntry({
    id: 'x4', source: 'mango', call_date: '2026-07-23T19:30:00.000Z',
    caller_name: 'Sam', call_reason: 'Question', transcript: 'Hello this is Sam calling about my bill.',
  }, { contentType: 'transcript' }).Note;
  assert.match(note, /--- Full transcript ---/);
  assert.match(note, /Hello this is Sam calling about my bill\./);
});

// ── Full summary in the chart note ───────────────────────────────────────────
// The team reported the chart note didn't match what the call page shows: the note
// carried only the compact block, never the full call.summary the app displays.

test('formatCommLogEntry: the full summary is appended in BOTH content types', () => {
  const call = {
    id: 's1', source: 'mango', call_date: '2026-07-23T19:30:00.000Z',
    caller_name: 'Sam Rivera', call_reason: 'Reschedule cleaning',
    action_needed: 'Call back to confirm Tue 2:30', callback_number: '4795551234',
    summary: 'Caller wants to move her Tuesday cleaning to the following week. '
      + 'She is available mornings and asked for a call back to confirm.',
    transcript: 'Hi, this is Sam, I need to reschedule my cleaning.',
  };

  const summaryNote = sync.formatCommLogEntry(call, { contentType: 'summary' }).Note;
  assert.match(summaryNote, /^Summary:$/m);
  assert.match(summaryNote, /Caller wants to move her Tuesday cleaning/);
  assert.match(summaryNote, /asked for a call back to confirm\./);
  // The compact block is still there, and still above the summary.
  assert.match(summaryNote, /^Caller: Sam Rivera$/m);
  assert.ok(summaryNote.indexOf('Callback #:') < summaryNote.indexOf('Summary:'));
  assert.ok(!/Full transcript/.test(summaryNote));

  // Transcript mode: compact block + summary + transcript, in that order.
  const transcriptNote = sync.formatCommLogEntry(call, { contentType: 'transcript' }).Note;
  assert.match(transcriptNote, /^Summary:$/m);
  assert.match(transcriptNote, /Caller wants to move her Tuesday cleaning/);
  assert.match(transcriptNote, /--- Full transcript ---/);
  assert.ok(transcriptNote.indexOf('Summary:') < transcriptNote.indexOf('--- Full transcript ---'));
});

test('formatCommLogEntry: no Summary section when Reason already fell back to it', () => {
  // With no call_reason, the Reason line IS call.summary. Printing the same
  // paragraph again reads like a formatting bug in the chart.
  const note = sync.formatCommLogEntry({
    id: 's2', source: 'mango', call_date: '2026-07-23T19:30:00.000Z',
    caller_name: 'Pat', summary: 'Caller asked about Saturday hours.',
    transcript: 'Are you open Saturdays?',
  }, {}).Note;
  assert.match(note, /^Reason: Caller asked about Saturday hours\.$/m);
  assert.ok(!/^Summary:$/m.test(note), 'summary written twice');
  assert.equal(note.match(/Caller asked about Saturday hours\./g).length, 1);
});

test('formatCommLogEntry: no-content call writes the minimal stub (item 5)', () => {
  // Missed/voicemail call — no transcript.
  const note = sync.formatCommLogEntry({
    id: 'nc1', source: 'mango', call_date: '2026-07-23T19:30:00.000Z',
    outcome: 'missed',
  }, {}).Note;
  assert.match(note, /^Call received .+, no recording available\.$/);
  assert.ok(!/Caller:/.test(note), 'no compact block for a no-content call');
  assert.ok(!/Summary:/.test(note), 'no summary section on the stub either');

  // Empty-string transcript is also "no content".
  const note2 = sync.formatCommLogEntry({
    id: 'nc2', source: 'mango', call_date: '2026-07-23T19:30:00.000Z', transcript: '   ',
  }, {}).Note;
  assert.match(note2, /no recording available\./);
});
