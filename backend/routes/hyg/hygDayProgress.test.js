'use strict';

/**
 * GET /api/hyg/day/progress — the day cards' pill, through the assembled chain.
 *
 * Four claims, each pinned here:
 *
 *   1. (office, apt_num) is the key. Roland's AptNum 100 and valley's AptNum
 *      100 are two different appointments in two databases, and each office
 *      gets its own state back — never the other's.
 *   2. ZERO Open Dental requests. Not a read, not a write. The pill is our own
 *      Postgres and nothing else.
 *   3. No PHI in the body: AptNums and states. No PatNum, no name.
 *   4. Bad input is a 400 HygError, never a partial answer.
 *
 * Synthetic rows only. PatNums are the staging fixtures (roland 12827,
 * valley 7115) and appear in the seeded DB, never in the response.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeHygDb, FakeOd, bootHygApp, api } = require('./hygTestUtils');
// The SAME schema the day page parses with, so a drift is red here first.
const { HygDayProgressResponseSchema } = require('../../hyg/contract.gen.cjs');

/** A hyg_visit row as the fake stores it. */
function visitRow(db, { office, aptNum, patNum, ...over }) {
  const row = {
    visit_id: db.nextId('visit'),
    office,
    apt_num: aptNum,
    pat_num: patNum,
    visit_date: '2026-09-08',
    slip: {},
    checkout_handoff_id: null,
    checkout_sent_at: null,
    checkout_sent_by: null,
    checkout_final_at: null,
    created_by: 'hygienist@carein.ai',
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
  db.hyg_visit.push(row);
  return row;
}

function stagedRow(db, visit, kind, state, over = {}) {
  db.hyg_staged_write.push({
    staged_write_id: db.nextId('sw'),
    visit_id: visit.visit_id,
    office: visit.office,
    kind,
    state,
    title: '',
    summary: '',
    preview: [],
    payload: {},
    error_message: state === 'Failed' ? 'Open Dental refused the write' : null,
    written_ref: state === 'Written' ? 'ref-1' : null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  });
}

/** A day with the same AptNum in both offices, in different states. */
function twoOfficeDb() {
  const db = new FakeHygDb();
  const roland = visitRow(db, { office: 'roland', aptNum: 100, patNum: 12827 });
  stagedRow(db, roland, 'note', 'Written');
  stagedRow(db, roland, 'router', 'Written');

  const valley = visitRow(db, { office: 'valley', aptNum: 100, patNum: 7115 });
  stagedRow(db, valley, 'note', 'Failed');
  stagedRow(db, valley, 'router', 'Staged');
  return db;
}

test('roland 100 and valley 100 each get their OWN state, never the other office\'s', async () => {
  const od = new FakeOd({});
  const app = await bootHygApp({ db: twoOfficeDb(), od });
  try {
    const r = await api(app.baseUrl, 'GET', '/api/hyg/day/progress?office=roland&apt=100');
    assert.equal(r.status, 200);
    assert.equal(r.body.office, 'roland');
    assert.equal(r.body.progress.length, 1);
    assert.equal(r.body.progress[0].aptNum, 100);
    assert.equal(r.body.progress[0].overall, 'sent');
    assert.equal(r.body.progress[0].steps.note.state, 'written');

    const v = await api(app.baseUrl, 'GET', '/api/hyg/day/progress?office=valley&apt=100');
    assert.equal(v.status, 200);
    assert.equal(v.body.office, 'valley');
    assert.equal(v.body.progress[0].overall, 'needs_attention');
    assert.equal(v.body.progress[0].steps.note.state, 'failed');
    assert.equal(v.body.progress[0].steps.slip.state, 'ready');
    for (const body of [r.body, v.body]) {
      assert.equal(HygDayProgressResponseSchema.safeParse(body).success, true, 'contract');
    }

    // Every statement named the office first. A query keyed by apt_num alone
    // would not have matched the fake at all.
    const progressSql = app.db.statements.filter((s) =>
      /FROM hyg_(visit|staged_write|perio_send|treatment_item)\s+WHERE office = \$1/.test(s)
    );
    assert.ok(progressSql.length >= 4, 'expected the office-keyed progress statements');
  } finally {
    await app.close();
  }
});

test('the progress route makes ZERO Open Dental requests — not even a read', async () => {
  const od = new FakeOd({});
  const app = await bootHygApp({ db: twoOfficeDb(), od });
  try {
    const r = await api(app.baseUrl, 'GET', '/api/hyg/day/progress?office=roland&apt=100,101,102');
    assert.equal(r.status, 200, 'the route must SUCCEED, or this proves nothing');
    assert.deepEqual(od.calls, [], 'no Open Dental read');
    assert.deepEqual(od.writes, [], 'no Open Dental write');
  } finally {
    await app.close();
  }
});

test('an appointment with no visit is not_started; every asked AptNum is answered', async () => {
  const app = await bootHygApp({ db: twoOfficeDb() });
  try {
    const r = await api(app.baseUrl, 'GET', '/api/hyg/day/progress?office=roland&apt=101,100,101');
    assert.equal(r.status, 200);
    // Deduped, in the caller's order.
    assert.deepEqual(
      r.body.progress.map((p) => [p.aptNum, p.overall]),
      [
        [101, 'not_started'],
        [100, 'sent'],
      ]
    );
    assert.equal(r.body.progress[0].steps, null);
    assert.equal(HygDayProgressResponseSchema.safeParse(r.body).success, true, 'contract');
  } finally {
    await app.close();
  }
});

test('the body carries AptNums and states only — no PatNum, no name', async () => {
  const app = await bootHygApp({ db: twoOfficeDb() });
  try {
    const r = await api(app.baseUrl, 'GET', '/api/hyg/day/progress?office=valley&apt=100');
    assert.equal(r.status, 200);
    const text = JSON.stringify(r.body);
    assert.doesNotMatch(text, /patNum|pat_num|patientName|7115|12827/i);
    assert.deepEqual(Object.keys(r.body).sort(), ['office', 'progress', 'success']);
    assert.deepEqual(Object.keys(r.body.progress[0]).sort(), ['aptNum', 'overall', 'steps']);
  } finally {
    await app.close();
  }
});

test('bad input is a 400 HygError', async () => {
  const app = await bootHygApp({});
  try {
    const cases = [
      ['?office=nope&apt=1', 'INVALID_OFFICE'],
      ['?apt=1', 'INVALID_OFFICE'],
      ['?office=roland', 'INVALID_APT_NUMS'],
      ['?office=roland&apt=', 'INVALID_APT_NUMS'],
      ['?office=roland&apt=0', 'INVALID_APT_NUMS'],
      ['?office=roland&apt=-3', 'INVALID_APT_NUMS'],
      ['?office=roland&apt=1.5', 'INVALID_APT_NUMS'],
      ['?office=roland&apt=abc', 'INVALID_APT_NUMS'],
      ['?office=roland&apt=1&apt=2', 'INVALID_APT_NUMS'],
      [
        '?office=roland&apt=' + Array.from({ length: 201 }, (_, i) => i + 1).join(','),
        'INVALID_APT_NUMS',
      ],
    ];
    for (const [qs, code] of cases) {
      const r = await api(app.baseUrl, 'GET', '/api/hyg/day/progress' + qs);
      assert.equal(r.status, 400, qs);
      assert.equal(r.body.success, false, qs);
      assert.equal(r.body.code, code, qs);
      assert.equal(typeof r.body.error, 'string', qs);
    }
  } finally {
    await app.close();
  }
});

test('behind the same module gate as /day: unentitled is 403', async () => {
  const app = await bootHygApp({ modules: [] });
  try {
    const r = await api(app.baseUrl, 'GET', '/api/hyg/day/progress?office=roland&apt=100');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'MODULE_NOT_ENTITLED');
  } finally {
    await app.close();
  }
});
