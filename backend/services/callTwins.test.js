const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  callerKey, isTwin, findTwin, isTransferDisconnect, mangoLegRole,
  END_SKEW_SECONDS, ROLE_DUPLICATE, ROLE_TRANSFERRED,
} = require('./callTwins');

/**
 * Fixtures are modelled on the SHAPE of real prod twins, with invented phone numbers.
 * The durations and offsets are the ones actually observed: a Mango leg that starts when
 * the call hits the PBX, and a Retell leg that starts `forwardDelay` seconds later when
 * the PBX gives up ringing and forwards — both ending at the same instant.
 */
const T0 = Date.parse('2026-08-01T15:00:00.000Z');
const iso = (offsetSeconds) => new Date(T0 + offsetSeconds * 1000).toISOString();

const mangoLeg = (over = {}) => ({
  id: 'mango_call_1',
  source: 'mango',
  caller_number: '(918) 555-0142',   // Mango's format
  called_number: '(918) 555-6262',
  direction: 'inbound',
  outcome: 'missed',                  // the PBX forwarded away, so Mango logs it missed
  call_date: iso(0),
  duration_seconds: 244,
  ...over,
});

const retellLeg = (over = {}) => ({
  id: 'call_abc',
  source: 'retell',
  caller_number: '+19185550142',      // Retell's format — same number, different shape
  called_number: '+14795550001',
  call_date: iso(7),                  // +7s ring-then-forward delay
  duration_seconds: 237,              // ends at the same instant as the Mango leg
  disconnection_reason: 'user_hangup',
  ...over,
});

test('callerKey normalizes across the two sources\' formats', () => {
  assert.equal(callerKey('(918) 555-0142'), '9185550142');
  assert.equal(callerKey('+19185550142'), '9185550142');
  assert.equal(callerKey('918-555-0142'), '9185550142');
  assert.equal(callerKey('19185550142'), '9185550142');
  // Too short to be a real line — must not become a join key.
  assert.equal(callerKey('5550142'), null);
  assert.equal(callerKey(''), null);
  assert.equal(callerKey(null), null);
  assert.equal(callerKey(undefined), null);
});

test('isTwin: the real twin shape matches (end-aligned, same caller)', () => {
  assert.equal(isTwin(mangoLeg(), retellLeg()), true);
});

test('isTwin: matches regardless of how each source formatted the number', () => {
  assert.equal(
    isTwin(mangoLeg({ caller_number: '918.555.0142' }), retellLeg({ caller_number: '+1 (918) 555-0142' })),
    true
  );
});

// ---------------------------------------------------------------------------
// FALSE-POSITIVE GUARDS. Each of these is a real population in the prod data
// that a looser rule would wrongly link (and therefore wrongly HIDE).
// ---------------------------------------------------------------------------

test('FP guard: a redial from the same number is NOT a twin (not end-aligned)', () => {
  // The prod store held 43 same-caller Mango pairs within 60s of each other. This is one:
  // the caller tries again a minute later and is missed again. It overlaps the AI call's
  // time window but does not share its end instant.
  const redial = mangoLeg({ id: 'mango_call_2', call_date: iso(60), duration_seconds: 30 });
  assert.equal(isTwin(redial, retellLeg()), false);
});

test('FP guard: a staff callback to the same number is NOT a twin (outbound)', () => {
  // Two of the 19 follow-legs on prod were the office calling the patient back. Burying
  // one of these would hide a human's actual work, so outbound is excluded explicitly as
  // well as by end-alignment.
  const callback = mangoLeg({
    id: 'mango_call_3', direction: 'outbound', outcome: 'answered',
    call_date: iso(250), duration_seconds: 66,
  });
  assert.equal(isTwin(callback, retellLeg()), false);
  // ...and it stays excluded even if its timings would otherwise align.
  const alignedOutbound = mangoLeg({ direction: 'outbound' });
  assert.equal(isTwin(alignedOutbound, retellLeg()), false);
});

test('FP guard: a different caller never twins, however well the times line up', () => {
  const other = retellLeg({ caller_number: '+19185550199' });
  assert.equal(isTwin(mangoLeg(), other), false);
});

test('FP guard: a zero-length PBX leg is refused rather than guessed at', () => {
  assert.equal(isTwin(mangoLeg({ duration_seconds: 0 }), retellLeg()), false);
});

test('FP guard: two Mango rows or two Retell rows can never be linked to each other', () => {
  assert.equal(isTwin(mangoLeg(), mangoLeg({ id: 'mango_call_9', source: 'mango' })), false);
  assert.equal(isTwin(retellLeg({ source: 'retell' }), retellLeg()), false);
});

test('end-skew tolerance: ±2s in, ±3s out', () => {
  // Retell leg ends exactly END_SKEW_SECONDS late → still the same conversation.
  const atLimit = retellLeg({ duration_seconds: 237 + END_SKEW_SECONDS });
  assert.equal(isTwin(mangoLeg(), atLimit), true);
  const overLimit = retellLeg({ duration_seconds: 237 + END_SKEW_SECONDS + 1 });
  assert.equal(isTwin(mangoLeg(), overLimit), false);
  // ...and symmetrically on the early side.
  const earlyAtLimit = retellLeg({ duration_seconds: 237 - END_SKEW_SECONDS });
  assert.equal(isTwin(mangoLeg(), earlyAtLimit), true);
  const earlyOverLimit = retellLeg({ duration_seconds: 237 - END_SKEW_SECONDS - 1 });
  assert.equal(isTwin(mangoLeg(), earlyOverLimit), false);
});

test('forward delay: a plausible ring is in, an implausible one is out', () => {
  // 119s of ringing then forward, still end-aligned → in.
  assert.equal(isTwin(mangoLeg({ duration_seconds: 356 }), retellLeg({ call_date: iso(119) })), true);
  // 121s → beyond the window.
  assert.equal(isTwin(mangoLeg({ duration_seconds: 358 }), retellLeg({ call_date: iso(121) })), false);
  // A Retell leg that started meaningfully BEFORE the PBX leg is not a forward at all.
  assert.equal(isTwin(mangoLeg({ call_date: iso(30) }), retellLeg({ call_date: iso(0) })), false);
});

test('findTwin returns the single match', () => {
  const { twin, ambiguous } = findTwin(mangoLeg(), [
    retellLeg({ id: 'call_other', caller_number: '+19185550199' }),
    retellLeg(),
  ]);
  assert.equal(ambiguous, false);
  assert.equal(twin.id, 'call_abc');
});

test('findTwin refuses to choose when two candidates both match', () => {
  // Hiding the WRONG row is worse than hiding none, so ambiguity links nothing.
  const { twin, ambiguous } = findTwin(mangoLeg(), [
    retellLeg({ id: 'call_one' }),
    retellLeg({ id: 'call_two' }),
  ]);
  assert.equal(twin, null);
  assert.equal(ambiguous, true);
});

test('findTwin on no candidates is a quiet no-match, not an ambiguity', () => {
  const { twin, ambiguous } = findTwin(mangoLeg(), []);
  assert.equal(twin, null);
  assert.equal(ambiguous, false);
});

test('isTransferDisconnect recognises transfer reasons, tolerating formatting', () => {
  assert.equal(isTransferDisconnect('call_transfer'), true);
  assert.equal(isTransferDisconnect('agent_transfer'), true);
  assert.equal(isTransferDisconnect('Call Transfer'), true);
  assert.equal(isTransferDisconnect('call-transfer'), true);
  // An unseen Retell variant must still trip the wire rather than read as AI-completed.
  assert.equal(isTransferDisconnect('transfer_to_front_desk'), true);

  assert.equal(isTransferDisconnect('user_hangup'), false);
  assert.equal(isTransferDisconnect('agent_hangup'), false);
  assert.equal(isTransferDisconnect(''), false);
  assert.equal(isTransferDisconnect(null), false);
  assert.equal(isTransferDisconnect(undefined), false);
});

test('mangoLegRole: AI-completed is a duplicate, transferred is not', () => {
  assert.equal(mangoLegRole(retellLeg()), ROLE_DUPLICATE);
  assert.equal(mangoLegRole(retellLeg({ disconnection_reason: null })), ROLE_DUPLICATE);
  // The transferred leg holds the human half of the conversation — never a duplicate.
  assert.equal(mangoLegRole(retellLeg({ disconnection_reason: 'call_transfer' })), ROLE_TRANSFERRED);
});
