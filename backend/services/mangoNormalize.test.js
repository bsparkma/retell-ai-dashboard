const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeMangoCall, extractPhone, isIngestibleCall, looksLikePhone } = require('./mangoNormalize');

const party = (over = {}) => ({
  caller_id: '+14795551234',
  formatted: '(479) 555-1234',
  cnam_location: 'AR',
  extension: {},
  phone_number: {},
  location: {},
  user: {},
  ...over,
});

test('looksLikePhone: needs >=7 digits', () => {
  assert.equal(looksLikePhone('+14795551234'), true);
  assert.equal(looksLikePhone('(479) 555-1234'), true);
  assert.equal(looksLikePhone('123'), false);
  assert.equal(looksLikePhone(''), false);
  assert.equal(looksLikePhone(null), false);
});

test('extractPhone: prefers caller_id, then formatted, then nested phone_number', () => {
  assert.equal(extractPhone(party()), '+14795551234');
  assert.equal(extractPhone(party({ caller_id: 'MAIN LINE' })), '(479) 555-1234'); // caller_id non-numeric -> formatted
  assert.equal(extractPhone(party({ caller_id: 'X', formatted: 'Y', phone_number: { e164: '+19185036262' } })), '+19185036262');
  assert.equal(extractPhone('+14790001111'), '+14790001111'); // string passthrough
  assert.equal(extractPhone(null), '');
});

test('isIngestibleCall: only standard inbound/outbound', () => {
  assert.equal(isIngestibleCall({ id: 1, type: 'standard', direction: 'inbound' }), true);
  assert.equal(isIngestibleCall({ id: 2, type: 'standard', direction: 'outbound' }), true);
  assert.equal(isIngestibleCall({ id: 3, type: 'standard', direction: 'internal' }), false);
  assert.equal(isIngestibleCall({ id: 4, type: 'fax', direction: 'inbound' }), false);
  assert.equal(isIngestibleCall({ id: 5, type: 'check voicemail', direction: 'inbound' }), false);
  assert.equal(isIngestibleCall({ type: 'standard', direction: 'inbound' }), false); // no id
});

test('normalizeMangoCall: inbound → called_number is the office DID (to)', () => {
  const c = normalizeMangoCall({
    id: 4310971580,
    direction: 'inbound',
    type: 'standard',
    is_missed: false,
    duration_in_seconds: 241,
    started_at: '2026-07-22T15:00:00Z',
    from: party({ caller_id: '+14795559999' }), // patient
    to: party({ caller_id: '+14792263500' }),   // Valley office DID
  });
  assert.equal(c.source, 'mango');
  assert.equal(c.external_id, 'mango_call_4310971580');
  assert.equal(c.mango_detail_url, 'https://app.mangovoice.com/calls/4310971580');
  assert.equal(c.caller_number, '+14795559999'); // external party
  assert.equal(c.called_number, '+14792263500'); // office line → attribution
  assert.equal(c.duration_seconds, 241);
  assert.equal(c.outcome, 'answered');
  assert.equal(c.recording_url, null); // D3: no local audio
});

test('normalizeMangoCall: outbound → called_number is still the office DID (from)', () => {
  const c = normalizeMangoCall({
    id: 99,
    direction: 'outbound',
    type: 'standard',
    is_missed: true,
    duration_in_seconds: 0,
    from: party({ caller_id: '+19185036262' }), // Roland office DID
    to: party({ caller_id: '+14795550000' }),   // patient
  });
  assert.equal(c.caller_number, '+14795550000'); // external party
  assert.equal(c.called_number, '+19185036262'); // office line
  assert.equal(c.outcome, 'missed');
});
