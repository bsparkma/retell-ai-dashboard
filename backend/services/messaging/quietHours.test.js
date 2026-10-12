'use strict';

/**
 * SMS quiet hours: 21:00–08:00 America/Chicago, hard block.
 *
 * Every boundary is written as the UTC instant it is on that date, with the
 * offset spelled out, so a reader can check the arithmetic: Central is UTC-5
 * under daylight time (CDT) and UTC-6 under standard time (CST). The two 2026
 * transition days are the ones that matter — a gate doing its own offset maths
 * would be an hour wrong on exactly one side of each.
 *
 *   2026-03-08  spring forward at 02:00 CST → 03:00 CDT  (both boundaries CDT)
 *   2026-11-01  fall back at 02:00 CDT → 01:00 CST       (both boundaries CST)
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { isQuietHours, localHour, QUIET_TZ } = require('./quietHours');

/** [label, utc instant, expected quiet?] */
const CASES = [
  // ── an ordinary CDT day (2026-10-08, UTC-5) ───────────────────────────────
  ['Oct 8 20:59 CDT', '2026-10-09T01:59:00Z', false],
  ['Oct 8 21:00 CDT', '2026-10-09T02:00:00Z', true],
  ['Oct 8 07:59 CDT', '2026-10-08T12:59:00Z', true],
  ['Oct 8 08:00 CDT', '2026-10-08T13:00:00Z', false],
  ['Oct 8 23:59:59 CDT', '2026-10-09T04:59:59Z', true],
  ['Oct 8 00:00 CDT', '2026-10-08T05:00:00Z', true],
  ['Oct 8 12:00 CDT', '2026-10-08T17:00:00Z', false],

  // ── spring-forward day 2026-03-08: 08:00 and 21:00 are both CDT (UTC-5) ───
  ['Mar 8 07:59 CDT', '2026-03-08T12:59:00Z', true],
  ['Mar 8 08:00 CDT', '2026-03-08T13:00:00Z', false],
  ['Mar 8 20:59 CDT', '2026-03-09T01:59:00Z', false],
  ['Mar 8 21:00 CDT', '2026-03-09T02:00:00Z', true],
  // An hour that a fixed UTC-6 assumption would get wrong: 13:30Z is 08:30 CDT
  // (allowed), but would read as 07:30 CST (quiet) under the old offset.
  ['Mar 8 08:30 CDT', '2026-03-08T13:30:00Z', false],
  // The instant just before the jump (01:59 CST) is quiet either way.
  ['Mar 8 01:59 CST', '2026-03-08T07:59:00Z', true],

  // ── fall-back day 2026-11-01: 08:00 and 21:00 are both CST (UTC-6) ────────
  ['Nov 1 07:59 CST', '2026-11-01T13:59:00Z', true],
  ['Nov 1 08:00 CST', '2026-11-01T14:00:00Z', false],
  ['Nov 1 20:59 CST', '2026-11-02T02:59:00Z', false],
  ['Nov 1 21:00 CST', '2026-11-02T03:00:00Z', true],
  // 13:30Z is 07:30 CST (quiet) — a stale UTC-5 assumption would call it 08:30.
  ['Nov 1 07:30 CST', '2026-11-01T13:30:00Z', true],
  // Both readings of the repeated 01:30 are quiet.
  ['Nov 1 01:30 CDT', '2026-11-01T06:30:00Z', true],
  ['Nov 1 01:30 CST', '2026-11-01T07:30:00Z', true],
];

for (const [label, utc, quiet] of CASES) {
  test(`quiet hours: ${label} (${utc}) → ${quiet ? 'BLOCKED' : 'allowed'}`, () => {
    assert.equal(isQuietHours(new Date(utc)), quiet);
  });
}

test('the boundary is Central time, not UTC: 21:00Z is 4 PM in Chicago and allowed', () => {
  assert.equal(isQuietHours(new Date('2026-10-08T21:00:00Z')), false);
  assert.equal(localHour(new Date('2026-10-08T21:00:00Z')), 16);
});

test('the zone is fixed to America/Chicago', () => {
  assert.equal(QUIET_TZ, 'America/Chicago');
});

test('an unreadable clock fails closed (quiet)', () => {
  assert.equal(isQuietHours(new Date(NaN)), true);
});
