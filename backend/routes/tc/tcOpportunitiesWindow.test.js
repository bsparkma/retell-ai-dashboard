'use strict';

/**
 * Item 45 — GET /api/tc/opportunities display window + maxAgeMonths, over the
 * real TC stack and FakeTenantDb.
 *
 * "Today" is pinned (window.setClockForTests) so every fixture date is exact.
 * Synthetic fixtures only: the designated PatNums (roland 12827 / 12828,
 * valley 7115) and obviously-synthetic 99xxxx numbers; "Test …" names.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { bootTcApp, api } = require('./tcTestUtils');
const oppWindow = require('../../services/tcOpportunities/window');

/** Oct 12 2026, midday in Chicago. */
const NOON_OCT_12 = Date.parse('2026-10-12T17:00:00Z');
const TODAY = '2026-10-12';

test.beforeEach(() => oppWindow.setClockForTests(() => NOON_OCT_12));
test.after(() => oppWindow.setClockForTests(null));

function proc(procNum, plannedDate, feeCents = 10000) {
  return { procNum, code: 'D2740', description: 'crown - porcelain/ceramic', feeCents, tooth: '3', surf: '', plannedDate };
}

function seedOpp(db, over = {}) {
  const procedures = over.procedures || [proc(1, '2026-09-01')];
  const dated = procedures.map((p) => p.plannedDate).filter(Boolean).sort();
  const row = {
    opportunity_id: randomUUID(),
    office_id: 'roland',
    od_patient_id: 990000,
    patient_name: 'Test, Window',
    patient_phone: null,
    patient_status: 'Patient',
    procedures,
    value_cents: procedures.reduce((s, p) => s + p.feeCents, 0),
    planned_date: dated.length ? dated[0] : null, // the sync's column: EARLIEST
    status: 'new',
    claimed_case_id: null,
    claimed_by: null,
    claimed_at: null,
    dismissed_reason: null,
    dismissed_by: null,
    dismissed_at: null,
    resurrected_at: null,
    cleared_at: null,
    first_seen_at: new Date('2026-10-01T07:30:00Z'),
    last_seen_at: new Date('2026-10-08T07:30:00Z'),
    ...over,
  };
  db.table('tc_opportunities').push(row);
  return row;
}

/**
 * One row per month of the 730-day capture: row k's (only) plan is dated
 * EXACTLY k months before today, k = 1..24. PatNum 990000 + k.
 */
function seedMonthLadder(db, office = 'roland') {
  for (let k = 1; k <= 24; k++) {
    seedOpp(db, {
      office_id: office,
      od_patient_id: 990000 + k,
      procedures: [proc(k, oppWindow.subtractMonths(TODAY, k), 1000 * k)],
    });
  }
}

const months = (body) => body.opportunities.map((o) => o.odPatientId - 990000).sort((a, b) => a - b);

test('capture vs display: 24 months captured, the default shows the 18-month window', async () => {
  const app = await bootTcApp();
  try {
    seedMonthLadder(app.db);
    assert.equal(app.db.table('tc_opportunities').length, 24, 'the 18–24-month band stays IN DATA');
    const r = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(months(r.body), Array.from({ length: 18 }, (_, i) => i + 1), 'exactly-18-months-ago is inside; 19+ is not');
    assert.deepEqual(r.body.totals, { count: 18, valueCents: Array.from({ length: 18 }, (_, i) => 1000 * (i + 1)).reduce((a, b) => a + b) });
    assert.deepEqual(r.body.window, { officeMonths: 18, appliedMonths: 18, since: '2025-04-12', includesUndated: true });
    assert.equal(app.db.table('tc_opportunities').length, 24, 'a read deletes nothing');
  } finally {
    await app.close();
  }
});

test('maxAgeMonths narrows server-side, for every chip value', async () => {
  const app = await bootTcApp();
  try {
    seedMonthLadder(app.db);
    for (const n of [1, 2, 3, 4, 6, 8, 12, 18]) {
      const r = await api(app.baseUrl, 'GET', `/api/tc/opportunities?office=roland&maxAgeMonths=${n}`);
      assert.equal(r.status, 200);
      assert.deepEqual(months(r.body), Array.from({ length: n }, (_, i) => i + 1), `${n} months`);
      assert.equal(r.body.totals.count, n);
      assert.equal(r.body.window.appliedMonths, n);
      assert.equal(r.body.window.officeMonths, 18);
    }
    // The filter is in the SQL, parameterized, no SELECT *.
    const sel = app.db.log.filter((l) => /FROM tc_opportunities/.test(l.sql) && /jsonb_array_elements/.test(l.sql));
    assert.ok(sel.length >= 8);
    for (const l of sel) {
      assert.doesNotMatch(l.sql, /SELECT \*/);
      assert.match(l.sql, /\$2::date/);
      assert.match(String(l.params[1]), /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(!l.sql.includes(String(l.params[1])), 'the date is a parameter, not interpolated');
    }
  } finally {
    await app.close();
  }
});

test('a plan exactly N months ago is in; one day older is out', async () => {
  const app = await bootTcApp();
  try {
    seedOpp(app.db, { od_patient_id: 990101, procedures: [proc(1, '2026-07-12')] }); // exactly 3 months
    seedOpp(app.db, { od_patient_id: 990102, procedures: [proc(2, '2026-07-11')] }); // 3 months + 1 day
    const r = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland&maxAgeMonths=3');
    assert.deepEqual(r.body.opportunities.map((o) => o.odPatientId), [990101]);
  } finally {
    await app.close();
  }
});

test('month-end: on Mar 31, a 1-month chip reaches back to Feb 28', async () => {
  oppWindow.setClockForTests(() => Date.parse('2026-03-31T17:00:00Z'));
  const app = await bootTcApp();
  try {
    seedOpp(app.db, { od_patient_id: 990201, procedures: [proc(1, '2026-02-28')] });
    seedOpp(app.db, { od_patient_id: 990202, procedures: [proc(2, '2026-02-27')] });
    const r = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland&maxAgeMonths=1');
    assert.equal(r.body.window.since, '2026-02-28');
    assert.deepEqual(r.body.opportunities.map((o) => o.odPatientId), [990201]);
  } finally {
    await app.close();
  }
});

test('America/Chicago day boundary: the cutoff moves at local midnight, not UTC midnight', async () => {
  const app = await bootTcApp();
  try {
    seedOpp(app.db, { od_patient_id: 990301, procedures: [proc(1, '2026-07-12')] });
    // 23:30 CDT Oct 12 (already Oct 13 in UTC): still Oct 12 → exactly 3 months → in.
    oppWindow.setClockForTests(() => Date.parse('2026-10-13T04:30:00Z'));
    const before = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland&maxAgeMonths=3');
    assert.equal(before.body.window.since, '2026-07-12');
    assert.equal(before.body.totals.count, 1);
    // 00:30 CDT Oct 13 → the plan is now 3 months + 1 day old → out.
    oppWindow.setClockForTests(() => Date.parse('2026-10-13T05:30:00Z'));
    const after = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland&maxAgeMonths=3');
    assert.equal(after.body.window.since, '2026-07-13');
    assert.equal(after.body.totals.count, 0);
  } finally {
    await app.close();
  }
});

test('age basis is the NEWEST planned procedure: re-diagnosed recently = fresh', async () => {
  const app = await bootTcApp();
  try {
    // 20-month-old crown, plus a filling planned 2 weeks ago.
    seedOpp(app.db, { od_patient_id: 12827, procedures: [proc(11, '2025-02-10'), proc(12, '2026-09-28')] });
    // Everything 20 months old.
    seedOpp(app.db, { od_patient_id: 12828, procedures: [proc(21, '2025-02-10')] });
    const r = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland&maxAgeMonths=1');
    assert.deepEqual(r.body.opportunities.map((o) => o.odPatientId), [12827]);
    const o = r.body.opportunities[0];
    assert.equal(o.newestPlannedDate, '2026-09-28');
    assert.equal(o.plannedDate, '2025-02-10', 'plannedDate stays the EARLIEST, as the sync wrote it');
    assert.equal(o.procedures.length, 2, 'the whole plan travels, not just the fresh line');
  } finally {
    await app.close();
  }
});

test('newest plan first, value then PatNum on ties', async () => {
  const app = await bootTcApp();
  try {
    seedOpp(app.db, { od_patient_id: 990401, procedures: [proc(1, '2026-01-01', 900000)] });
    seedOpp(app.db, { od_patient_id: 990402, procedures: [proc(2, '2026-09-01', 1000)] });
    seedOpp(app.db, { od_patient_id: 990403, procedures: [proc(3, '2026-09-01', 5000)] });
    seedOpp(app.db, { od_patient_id: 990404, procedures: [proc(4, null, 99999)] });
    const r = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland');
    assert.deepEqual(r.body.opportunities.map((o) => o.odPatientId), [990403, 990402, 990401, 990404]);
  } finally {
    await app.close();
  }
});

test('undated plans: shown in the full window, never under a narrower chip', async () => {
  const app = await bootTcApp();
  try {
    seedOpp(app.db, { od_patient_id: 990501, procedures: [proc(1, null)] });
    seedOpp(app.db, { od_patient_id: 990502, procedures: [proc(2, '2026-10-01')] });
    const all = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland');
    assert.deepEqual(all.body.opportunities.map((o) => o.odPatientId).sort(), [990501, 990502]);
    assert.equal(all.body.window.includesUndated, true);
    const narrow = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland&maxAgeMonths=1');
    assert.deepEqual(narrow.body.opportunities.map((o) => o.odPatientId), [990502]);
    assert.equal(narrow.body.window.includesUndated, false);
    // Explicitly asking for the window is the window.
    const eighteen = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland&maxAgeMonths=18');
    assert.equal(eighteen.body.totals.count, 2);
  } finally {
    await app.close();
  }
});

test('maxAgeMonths validation: 400 with the structured error shape, nothing read', async () => {
  const app = await bootTcApp();
  try {
    seedMonthLadder(app.db);
    for (const bad of ['0', '25', '-1', '3.5', 'abc', '1e1', '6&maxAgeMonths=7']) {
      const r = await api(app.baseUrl, 'GET', `/api/tc/opportunities?office=roland&maxAgeMonths=${bad}`);
      assert.equal(r.status, 400, bad);
      assert.deepEqual(Object.keys(r.body).sort(), ['code', 'error', 'success']);
      assert.equal(r.body.success, false);
      assert.equal(r.body.code, 'INVALID_MAX_AGE_MONTHS');
      assert.match(r.body.error, /1 to 24/);
    }
    assert.equal(
      app.db.log.filter((l) => /FROM tc_opportunities/.test(l.sql)).length,
      0,
      'a refused request never reads the table'
    );
    // Blank = absent = the window.
    const blank = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland&maxAgeMonths=');
    assert.equal(blank.status, 200);
    assert.equal(blank.body.window.appliedMonths, 18);
  } finally {
    await app.close();
  }
});

test('a chip wider than the office window is clamped to it (the 18–24 band is a later slice)', async () => {
  const app = await bootTcApp();
  try {
    seedMonthLadder(app.db);
    const r = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland&maxAgeMonths=24');
    assert.equal(r.status, 200);
    assert.equal(r.body.window.appliedMonths, 18);
    assert.equal(r.body.totals.count, 18);
  } finally {
    await app.close();
  }
});

test('the office window is per office, from the library section (default 18)', async () => {
  const app = await bootTcApp();
  try {
    seedMonthLadder(app.db, 'roland');
    seedMonthLadder(app.db, 'valley');
    const put = await api(app.baseUrl, 'PUT', '/api/tc/library/opportunities_config?office=roland', {
      opportunitiesWindowMonths: 6,
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    const roland = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland');
    assert.deepEqual(roland.body.window, { officeMonths: 6, appliedMonths: 6, since: '2026-04-12', includesUndated: true });
    assert.equal(roland.body.totals.count, 6);
    // A chip can narrow under it but not past it.
    const chip = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland&maxAgeMonths=12');
    assert.equal(chip.body.window.appliedMonths, 6);
    assert.equal(chip.body.totals.count, 6);

    const valley = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=valley');
    assert.equal(valley.body.window.officeMonths, 18, 'valley keeps the default');
    assert.equal(valley.body.totals.count, 18);
    for (const o of valley.body.opportunities) assert.equal(o.officeId, 'valley');

    // The library validates the bounds; nothing invalid reaches the table.
    for (const bad of [0, 25, 6.5, '6']) {
      const r = await api(app.baseUrl, 'PUT', '/api/tc/library/opportunities_config?office=valley', {
        opportunitiesWindowMonths: bad,
      });
      assert.equal(r.status, 400, String(bad));
    }
    assert.equal(
      app.db.table('tc_library_config').filter((r) => r.office_id === 'valley').length,
      0
    );
  } finally {
    await app.close();
  }
});

test('the window applies to every tab, and totals are over the windowed set', async () => {
  const app = await bootTcApp();
  try {
    seedOpp(app.db, { od_patient_id: 990601, status: 'dismissed', dismissed_reason: 'Declined', procedures: [proc(1, '2026-09-01')] });
    seedOpp(app.db, { od_patient_id: 990602, status: 'dismissed', dismissed_reason: 'Declined', procedures: [proc(2, '2024-12-01')] });
    const r = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland&status=dismissed');
    assert.deepEqual(r.body.opportunities.map((o) => o.odPatientId), [990601]);
    assert.equal(r.body.totals.count, 1);
  } finally {
    await app.close();
  }
});
