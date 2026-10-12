'use strict';

/**
 * Item 45 — the Opportunities display window's pure rules (window.js).
 *
 * Calendar-only month arithmetic (the lib/followups.ts pattern), the
 * America/Chicago "today", the maxAgeMonths parser, the window resolution and
 * the office-setting read. No patient data at all.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const w = require('./window');
const { LibrarySectionSchemas } = require('../../tc/contract.gen.cjs');

const CHI = 'America/Chicago';

test('subtractMonths: plain months, year rollover, 18 and 24', () => {
  assert.equal(w.subtractMonths('2026-10-12', 0), '2026-10-12');
  assert.equal(w.subtractMonths('2026-10-12', 1), '2026-09-12');
  assert.equal(w.subtractMonths('2026-10-12', 12), '2025-10-12');
  assert.equal(w.subtractMonths('2026-10-12', 18), '2025-04-12');
  assert.equal(w.subtractMonths('2026-10-12', 24), '2024-10-12');
  assert.equal(w.subtractMonths('2026-01-15', 1), '2025-12-15');
  assert.equal(w.subtractMonths('2026-02-01', 14), '2024-12-01');
});

test('subtractMonths: month-end clamps to the shorter month, never spills forward', () => {
  assert.equal(w.subtractMonths('2026-03-31', 1), '2026-02-28', 'Mar 31 − 1 month = Feb 28 (not Mar 3)');
  assert.equal(w.subtractMonths('2028-03-31', 1), '2028-02-29', 'leap year');
  assert.equal(w.subtractMonths('2026-05-31', 1), '2026-04-30');
  assert.equal(w.subtractMonths('2026-12-31', 6), '2026-06-30');
  assert.equal(w.subtractMonths('2027-01-31', 1), '2026-12-31');
  assert.equal(w.subtractMonths('2028-02-29', 12), '2027-02-28', 'Feb 29 a year back');
  assert.equal(w.subtractMonths('2026-08-31', 18), '2025-02-28');
});

test('subtractMonths refuses garbage rather than guessing', () => {
  assert.throws(() => w.subtractMonths('Oct 12 2026', 1));
  assert.throws(() => w.subtractMonths('2026-10-12', -1));
  assert.throws(() => w.subtractMonths('2026-10-12', 1.5));
});

test('localToday: America/Chicago day boundaries, CDT and CST, independent of the server zone', () => {
  // CDT (UTC−5): local midnight is 05:00Z.
  assert.equal(w.localToday(new Date('2026-10-13T04:59:59Z'), CHI), '2026-10-12');
  assert.equal(w.localToday(new Date('2026-10-13T05:00:00Z'), CHI), '2026-10-13');
  // CST (UTC−6): local midnight is 06:00Z.
  assert.equal(w.localToday(new Date('2026-01-15T05:59:59Z'), CHI), '2026-01-14');
  assert.equal(w.localToday(new Date('2026-01-15T06:00:00Z'), CHI), '2026-01-15');
  // The same instant is a different day in UTC — the zone argument decides.
  assert.equal(w.localToday(new Date('2026-10-13T04:59:59Z'), 'UTC'), '2026-10-13');
});

test('windowCutoff: a plan dated EXACTLY N months ago is inside; one day older is not', () => {
  const at = new Date('2026-10-12T17:00:00Z'); // Oct 12, midday in Chicago
  for (const n of [1, 2, 3, 4, 6, 8, 12, 18, 24]) {
    const cutoff = w.windowCutoff(n, at, CHI);
    const exactly = w.subtractMonths('2026-10-12', n);
    assert.equal(cutoff, exactly);
    assert.ok(exactly >= cutoff, `${n} months: exactly-N is inside`);
    const [y, m, d] = exactly.split('-').map(Number);
    const dayOlder = new Date(Date.UTC(y, m - 1, d) - 86400000).toISOString().slice(0, 10);
    assert.ok(dayOlder < cutoff, `${n} months: a day older is outside`);
  }
});

test('windowCutoff moves at CHICAGO midnight, not UTC midnight', () => {
  // 23:30 CDT on Oct 12 is already Oct 13 in UTC.
  assert.equal(w.windowCutoff(3, new Date('2026-10-13T04:30:00Z'), CHI), '2026-07-12');
  assert.equal(w.windowCutoff(3, new Date('2026-10-13T05:30:00Z'), CHI), '2026-07-13');
  // Month-end through a zone boundary: Mar 31 local, 1 month → Feb 28.
  assert.equal(w.windowCutoff(1, new Date('2026-04-01T04:30:00Z'), CHI), '2026-02-28');
});

test('newestPlannedDate: the NEWEST dated procedure; undated ignored; none dated → null', () => {
  assert.equal(
    w.newestPlannedDate([{ plannedDate: '2025-02-01' }, { plannedDate: '2026-09-30' }, { plannedDate: null }]),
    '2026-09-30'
  );
  assert.equal(w.newestPlannedDate([{ plannedDate: null }, {}]), null);
  assert.equal(w.newestPlannedDate([]), null);
  assert.equal(w.newestPlannedDate(undefined), null);
  assert.equal(w.newestPlannedDate([{ plannedDate: 'not a date' }, { plannedDate: '2026-01-01' }]), '2026-01-01');
});

test('parseMaxAgeMonths: integers 1..24 only; absent/blank = the office window', () => {
  assert.deepEqual(w.parseMaxAgeMonths(undefined), { ok: true, value: null });
  assert.deepEqual(w.parseMaxAgeMonths(''), { ok: true, value: null });
  assert.deepEqual(w.parseMaxAgeMonths('1'), { ok: true, value: 1 });
  assert.deepEqual(w.parseMaxAgeMonths('18'), { ok: true, value: 18 });
  assert.deepEqual(w.parseMaxAgeMonths('24'), { ok: true, value: 24 });
  for (const bad of ['0', '25', '-1', '3.5', '3abc', 'abc', '1e1', '0x3', '1000', ['3', '4'], { a: 1 }]) {
    assert.deepEqual(w.parseMaxAgeMonths(bad), { ok: false }, JSON.stringify(bad));
  }
});

test('resolveWindow: a chip narrows within the window and never widens past it', () => {
  assert.deepEqual(w.resolveWindow(18, null), { officeMonths: 18, appliedMonths: 18, includeUndated: true });
  assert.deepEqual(w.resolveWindow(18, 3), { officeMonths: 18, appliedMonths: 3, includeUndated: false });
  assert.deepEqual(w.resolveWindow(18, 18), { officeMonths: 18, appliedMonths: 18, includeUndated: true });
  assert.deepEqual(w.resolveWindow(18, 24), { officeMonths: 18, appliedMonths: 18, includeUndated: true });
  assert.deepEqual(w.resolveWindow(6, 12), { officeMonths: 6, appliedMonths: 6, includeUndated: true });
});

test('readOfficeWindowMonths: the library section, else the contract default (18)', async () => {
  const q = (rows) => ({
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      return { rows };
    },
  });
  const none = q([]);
  assert.equal(await w.readOfficeWindowMonths(none, 'roland'), 18);
  assert.deepEqual(none.calls[0].params, ['roland', 'opportunities_config']);
  assert.match(none.calls[0].sql, /WHERE office_id = \$1 AND section = \$2/);
  assert.doesNotMatch(none.calls[0].sql, /SELECT \*/);
  assert.equal(await w.readOfficeWindowMonths(q([{ value: { opportunitiesWindowMonths: 6 } }]), 'roland'), 6);
  assert.equal(await w.readOfficeWindowMonths(q([{ value: '{"opportunitiesWindowMonths":12}' }]), 'roland'), 12);
  assert.equal(await w.readOfficeWindowMonths(q([{ value: {} }]), 'roland'), 18, 'schema default');
  assert.equal(await w.readOfficeWindowMonths(q([{ value: { opportunitiesWindowMonths: 99 } }]), 'roland'), 18);
  assert.equal(await w.readOfficeWindowMonths(q([{ value: 'not json' }]), 'roland'), 18);
});

test('the contract owns the bounds: 1..24, default 18', () => {
  const s = LibrarySectionSchemas.opportunities_config;
  assert.deepEqual(s.parse({}), { opportunitiesWindowMonths: 18 });
  assert.equal(s.safeParse({ opportunitiesWindowMonths: 0 }).success, false);
  assert.equal(s.safeParse({ opportunitiesWindowMonths: 25 }).success, false);
  assert.equal(s.safeParse({ opportunitiesWindowMonths: 6.5 }).success, false);
  assert.equal(w.MIN_MONTHS, 1);
  assert.equal(w.MAX_MONTHS, 24);
  assert.equal(w.DEFAULT_MONTHS, 18);
});
