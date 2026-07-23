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

test('buildCommLogApiPayload maps DB-shaped entry to the real OD /commlogs contract', () => {
  const payload = sync.buildCommLogApiPayload(1001, {
    CommDateTime: '2026-06-04T15:30:00.000Z',
    Mode_: 3,            // DB int -> "Phone"
    SentOrReceived: 1,   // inbound -> "Received"
    Note: 'CareIN call summary',
    CommType: 2          // ignored on the API path; replaced by the configured DefNum
  });

  assert.equal(payload.PatNum, 1001);
  assert.equal(payload.Note, 'CareIN call summary');
  assert.equal(payload.CommDateTime, '2026-06-04 15:30:00'); // no T/Z, OD format
  assert.equal(payload.Mode_, 'Phone');                      // string enum, not 3
  assert.equal(payload.SentOrReceived, 'Received');          // string enum, not 1
  assert.equal(typeof payload.Mode_, 'string');
  assert.equal(typeof payload.SentOrReceived, 'string');
  assert.equal(payload.CommType, sync.careinCommType);       // configured DefNum (default 486)
});

test('careinCommType defaults to the CareIN convention DefNum 486', () => {
  // (Unless OPENDENTAL_CAREIN_COMMTYPE_DEFNUM overrides it in the environment.)
  if (!process.env.OPENDENTAL_CAREIN_COMMTYPE_DEFNUM) {
    assert.equal(sync.careinCommType, 486);
  }
});

test('createCommLog POSTs /commlogs with the API payload when in api mode', async () => {
  const prev = { useDatabase: openDentalService.useDatabase, pool: openDentalService.pool, client: openDentalService.client };
  const calls = [];
  openDentalService.useDatabase = false;
  openDentalService.pool = null;
  openDentalService.client = {
    post: async (url, body) => { calls.push({ url, body }); return { data: { CommlogNum: 7777 } }; }
  };

  try {
    const result = await sync.createCommLog(1001, {
      CommDateTime: '2026-06-04 15:30:00', Mode_: 3, SentOrReceived: 1, Note: 'hi', CommType: 1
    });
    assert.equal(result.success, true);
    assert.equal(result.commLogNum, 7777);
    assert.equal(calls[0].url, '/commlogs');
    assert.equal(calls[0].body.Mode_, 'Phone');
    assert.equal(calls[0].body.SentOrReceived, 'Received');
    assert.equal(calls[0].body.PatNum, 1001);
  } finally {
    Object.assign(openDentalService, prev);
  }
});

test('createCommLog reports failure (not a throw) when no OD connection is available', async () => {
  const prev = { useDatabase: openDentalService.useDatabase, pool: openDentalService.pool, client: openDentalService.client };
  openDentalService.useDatabase = false;
  openDentalService.pool = null;
  openDentalService.client = null;
  try {
    const result = await sync.createCommLog(1001, { Note: 'x', CommDateTime: '2026-06-04 15:30:00' });
    assert.equal(result.success, false);
    assert.match(result.error, /No Open Dental connection/);
  } finally {
    Object.assign(openDentalService, prev);
  }
});

// ── Compact summary block (day-1 item 2) ─────────────────────────────────────

test('formatCommLogEntry: compact 4-field summary block (default contentType)', () => {
  const note = sync.formatCommLogEntry({
    id: 'x1', source: 'mango', call_date: '2026-07-23T19:30:00.000Z',
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
    caller_name: 'Pat', call_reason: 'Broken tooth', is_emergency: true,
    callback_required: true, caller_number: '9185550000',
  }, {}).Note;
  assert.match(note, /^Reason: Broken tooth \[EMERGENCY\]$/m);
  assert.match(note, /^Callback #: 9185550000$/m);

  // Nothing to call back on → dash.
  const note2 = sync.formatCommLogEntry({
    id: 'x3', source: 'mango', call_date: '2026-07-23T19:30:00.000Z',
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
