'use strict';

/**
 * The consent gate, exhaustively. Rule order (consent.js header):
 *   1. opted_out → CONSENT_OPTED_OUT, beats everything
 *   2. SMS + linked OD patient: TxtMsgOk No → OD_TEXT_CONSENT_NO;
 *      unreadable → OD_CONSENT_UNAVAILABLE (fail closed); ?? → allowed + badge
 *   3. SMS in quiet hours → QUIET_HOURS. Email exempt.
 *
 * Fixtures: roland 12827 / 12828, valley 7115 only. Addresses are 555-01xx
 * fictional numbers.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const consent = require('./consent');
const odOffices = require('../../config/odOffices');
const { resetOdPatientCache } = require('../odPatientCache');

const PHONE = '+14795550101';
const EMAIL = 'patient@example.test';
const DAY = new Date('2026-10-08T17:00:00Z'); // 12:00 CDT
const NIGHT = new Date('2026-10-09T03:00:00Z'); // 22:00 CDT

/** A fake tenant DB holding consent rows. */
function fakeQ(rows = []) {
  return {
    calls: 0,
    async query(_sql, [office, channel, address]) {
      this.calls += 1;
      return {
        rows: rows.filter((r) => r.office_id === office && r.channel === channel && r.address === address),
      };
    },
  };
}
const optedOut = (office, channel, address) => ({ office_id: office, channel, address, state: 'opted_out', source: 'manual' });
const optedIn = (office, channel, address) => ({ office_id: office, channel, address, state: 'opted_in', source: 'od' });

/** Stub OD: records calls; answers TxtMsgOk per office+PatNum. */
function stubOd(table) {
  const calls = [];
  consent.setOdPatientReaderForTests(async (office, patNum) => {
    calls.push({ office, patNum });
    const key = `${office}:${patNum}`;
    if (!(key in table)) return null;
    const v = table[key];
    if (v instanceof Error) throw v;
    return { PatNum: patNum, TxtMsgOk: v };
  });
  return calls;
}

test.afterEach(() => consent.resetOdPatientReader());

// ── 1. opt-out beats everything ─────────────────────────────────────────────

test('opted_out blocks SMS even with OD Yes, in the daytime — and OD is never read', async () => {
  const calls = stubOd({ 'roland:12828': 'Yes' });
  const d = await consent.canMessage(fakeQ([optedOut('roland', 'sms', PHONE)]), {
    office: 'roland', channel: 'sms', address: PHONE, odPatientId: 12828, now: DAY,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'CONSENT_OPTED_OUT');
  assert.equal(d.odTextConsent, 'not_checked');
  assert.equal(calls.length, 0, 'an opt-out needs no OD read');
});

test('opted_out beats quiet hours too (the opt-out is the code reported)', async () => {
  stubOd({ 'roland:12828': 'Yes' });
  const d = await consent.canMessage(fakeQ([optedOut('roland', 'sms', PHONE)]), {
    office: 'roland', channel: 'sms', address: PHONE, odPatientId: 12828, now: NIGHT,
  });
  assert.equal(d.code, 'CONSENT_OPTED_OUT');
  assert.equal(d.quietHours, true);
});

test('opted_out blocks email', async () => {
  const d = await consent.canMessage(fakeQ([optedOut('roland', 'email', EMAIL)]), {
    office: 'roland', channel: 'email', address: EMAIL, now: DAY,
  });
  assert.equal(d.code, 'CONSENT_OPTED_OUT');
});

test('an opt-out is per OFFICE: a roland opt-out does not exist in valley', async () => {
  stubOd({ 'valley:7115': 'Yes' });
  const d = await consent.canMessage(fakeQ([optedOut('roland', 'sms', PHONE)]), {
    office: 'valley', channel: 'sms', address: PHONE, odPatientId: 7115, now: DAY,
  });
  assert.equal(d.allowed, true);
});

test('an opt-out is per CHANNEL: an SMS opt-out does not block email', async () => {
  const d = await consent.canMessage(fakeQ([optedOut('roland', 'sms', EMAIL)]), {
    office: 'roland', channel: 'email', address: EMAIL, now: DAY,
  });
  assert.equal(d.allowed, true);
});

// ── 2. Open Dental TxtMsgOk ─────────────────────────────────────────────────

test('OD TxtMsgOk No blocks SMS', async () => {
  stubOd({ 'roland:12828': 'No' });
  const d = await consent.canMessage(fakeQ(), {
    office: 'roland', channel: 'sms', address: PHONE, odPatientId: 12828, now: DAY,
  });
  assert.equal(d.code, 'OD_TEXT_CONSENT_NO');
  assert.equal(d.odTextConsent, 'no');
});

test('OD No blocks even when CareIN holds an opted_in row (OD No is not overridable)', async () => {
  stubOd({ 'roland:12828': 'No' });
  const d = await consent.canMessage(fakeQ([optedIn('roland', 'sms', PHONE)]), {
    office: 'roland', channel: 'sms', address: PHONE, odPatientId: 12828, now: DAY,
  });
  assert.equal(d.code, 'OD_TEXT_CONSENT_NO');
});

test('OD No is reported ahead of quiet hours', async () => {
  stubOd({ 'roland:12828': 'No' });
  const d = await consent.canMessage(fakeQ(), {
    office: 'roland', channel: 'sms', address: PHONE, odPatientId: 12828, now: NIGHT,
  });
  assert.equal(d.code, 'OD_TEXT_CONSENT_NO');
});

test('OD ?? (unknown) is allowed in v1, and surfaced as `unknown` for the badge', async () => {
  stubOd({ 'roland:12828': '??' });
  const d = await consent.canMessage(fakeQ(), {
    office: 'roland', channel: 'sms', address: PHONE, odPatientId: 12828, now: DAY,
  });
  assert.equal(d.allowed, true);
  assert.equal(d.odTextConsent, 'unknown');
});

test('OD Yes is allowed', async () => {
  stubOd({ 'roland:12828': 'Yes' });
  const d = await consent.canMessage(fakeQ(), {
    office: 'roland', channel: 'sms', address: PHONE, odPatientId: 12828, now: DAY,
  });
  assert.equal(d.allowed, true);
  assert.equal(d.odTextConsent, 'yes');
});

test('OD unreadable (record null) FAILS CLOSED with its own code', async () => {
  stubOd({});
  const d = await consent.canMessage(fakeQ(), {
    office: 'roland', channel: 'sms', address: PHONE, odPatientId: 12827, now: DAY,
  });
  assert.equal(d.code, 'OD_CONSENT_UNAVAILABLE');
});

test('OD read that throws FAILS CLOSED', async () => {
  stubOd({ 'roland:12827': new Error('socket hang up') });
  const d = await consent.canMessage(fakeQ(), {
    office: 'roland', channel: 'sms', address: PHONE, odPatientId: 12827, now: DAY,
  });
  assert.equal(d.code, 'OD_CONSENT_UNAVAILABLE');
});

test('an unrecognised TxtMsgOk value FAILS CLOSED', async () => {
  stubOd({ 'roland:12827': 'Maybe' });
  const d = await consent.canMessage(fakeQ(), {
    office: 'roland', channel: 'sms', address: PHONE, odPatientId: 12827, now: DAY,
  });
  assert.equal(d.code, 'OD_CONSENT_UNAVAILABLE');
});

test('the OD read is keyed by the CALLER office + PatNum (7115 in valley is not 7115 in roland)', async () => {
  const calls = stubOd({ 'valley:7115': 'No', 'roland:7115': 'Yes' });
  const v = await consent.canMessage(fakeQ(), {
    office: 'valley', channel: 'sms', address: PHONE, odPatientId: 7115, now: DAY,
  });
  assert.equal(v.code, 'OD_TEXT_CONSENT_NO');
  assert.deepEqual(calls, [{ office: 'valley', patNum: 7115 }]);
});

test('a case with no linked OD patient reads nothing and passes as not_linked', async () => {
  const calls = stubOd({});
  for (const odPatientId of [null, undefined, 0, -1, 'abc']) {
    const d = await consent.canMessage(fakeQ(), {
      office: 'roland', channel: 'sms', address: PHONE, odPatientId, now: DAY,
    });
    assert.equal(d.allowed, true, String(odPatientId));
    assert.equal(d.odTextConsent, 'not_linked');
  }
  assert.equal(calls.length, 0);
});

test('a pg bigint PatNum (string) is accepted', async () => {
  const calls = stubOd({ 'roland:12828': 'Yes' });
  const d = await consent.canMessage(fakeQ(), {
    office: 'roland', channel: 'sms', address: PHONE, odPatientId: '12828', now: DAY,
  });
  assert.equal(d.allowed, true);
  assert.deepEqual(calls, [{ office: 'roland', patNum: 12828 }]);
});

test('email never reads OD TxtMsgOk', async () => {
  const calls = stubOd({ 'roland:12828': 'No' });
  const d = await consent.canMessage(fakeQ(), {
    office: 'roland', channel: 'email', address: EMAIL, odPatientId: 12828, now: DAY,
  });
  assert.equal(d.allowed, true);
  assert.equal(d.odTextConsent, 'not_checked');
  assert.equal(calls.length, 0);
});

test('parseTxtMsgOk: the YN vocabulary, and everything else is unavailable', () => {
  const table = [
    ['Yes', 'yes'], ['yes', 'yes'], [1, 'yes'], [true, 'yes'],
    ['No', 'no'], [' no ', 'no'], [2, 'no'], [false, 'no'],
    ['??', 'unknown'], ['Unknown', 'unknown'], [0, 'unknown'], ['', 'unknown'],
    [undefined, 'unavailable'], [null, 'unavailable'], ['Maybe', 'unavailable'], [3, 'unavailable'], [{}, 'unavailable'],
  ];
  for (const [raw, want] of table) assert.equal(consent.parseTxtMsgOk(raw), want, JSON.stringify(raw));
});

// ── 3. quiet hours ──────────────────────────────────────────────────────────

test('SMS in quiet hours is blocked even with OD Yes', async () => {
  stubOd({ 'roland:12828': 'Yes' });
  const d = await consent.canMessage(fakeQ(), {
    office: 'roland', channel: 'sms', address: PHONE, odPatientId: 12828, now: NIGHT,
  });
  assert.equal(d.code, 'QUIET_HOURS');
  assert.match(d.message, /9:00 PM and 8:00 AM Central/);
});

test('SMS quiet-hours boundaries through the gate: 20:59 / 21:00 / 07:59 / 08:00 on a DST day', async () => {
  stubOd({ 'roland:12828': 'Yes' });
  const expect = [
    ['2026-03-09T01:59:00Z', true], // Mar 8 20:59 CDT
    ['2026-03-09T02:00:00Z', false], // Mar 8 21:00 CDT
    ['2026-03-08T12:59:00Z', false], // Mar 8 07:59 CDT
    ['2026-03-08T13:00:00Z', true], // Mar 8 08:00 CDT
    ['2026-11-02T02:59:00Z', true], // Nov 1 20:59 CST
    ['2026-11-02T03:00:00Z', false], // Nov 1 21:00 CST
    ['2026-11-01T13:59:00Z', false], // Nov 1 07:59 CST
    ['2026-11-01T14:00:00Z', true], // Nov 1 08:00 CST
  ];
  for (const [utc, allowed] of expect) {
    const d = await consent.canMessage(fakeQ(), {
      office: 'roland', channel: 'sms', address: PHONE, odPatientId: 12828, now: new Date(utc),
    });
    assert.equal(d.allowed, allowed, utc);
    if (!allowed) assert.equal(d.code, 'QUIET_HOURS', utc);
  }
});

test('email is exempt from quiet hours', async () => {
  const d = await consent.canMessage(fakeQ(), {
    office: 'roland', channel: 'email', address: EMAIL, now: NIGHT,
  });
  assert.equal(d.allowed, true);
  assert.equal(d.quietHours, false);
});

// ── the real reader fails closed when the office has no OD connection ──────

test('default reader: an office with no OD key reads as unavailable → blocked (never another office)', async () => {
  const saved = { r: process.env.OPENDENTAL_CUSTOMER_KEY, v: process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY };
  delete process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
  process.env.OPENDENTAL_CUSTOMER_KEY = 'placeholder-roland-key';
  odOffices.resetOdOfficeCache();
  resetOdPatientCache();
  consent.resetOdPatientReader();
  try {
    const d = await consent.canMessage(fakeQ(), {
      office: 'valley', channel: 'sms', address: PHONE, odPatientId: 7115, now: DAY,
    });
    assert.equal(d.code, 'OD_CONSENT_UNAVAILABLE');
  } finally {
    if (saved.r === undefined) delete process.env.OPENDENTAL_CUSTOMER_KEY;
    else process.env.OPENDENTAL_CUSTOMER_KEY = saved.r;
    if (saved.v === undefined) delete process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
    else process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = saved.v;
    odOffices.resetOdOfficeCache();
  }
});
