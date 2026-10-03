'use strict';

/**
 * MISSING TEETH PRE-SKIP THEMSELVES (item 27) — the route's half.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS ROUTE OWES THE CHART
 * ═════════════════════════════════════════════════════════════════════════════
 * It states a FACT about Open Dental — which teeth are recorded Missing — and
 * nothing more. It does not alter a chart, it does not decide whether the
 * pre-skip applies, and the client is free to ignore it. Everything asserted
 * here is either that fact, its cost, or its trail.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE REQUEST BUDGET IS THE POINT, NOT A DETAIL
 * ═════════════════════════════════════════════════════════════════════════════
 * A chart open was two Open Dental requests (`/perioexams` + `/periomeasures`,
 * both inside this route). Item 27 may add ONE, and only where it can be used:
 * a visit that already holds a stored chart can never be pre-skipped, so it
 * spends NOTHING. Both halves are asserted against the recorded request list,
 * because a budget nobody counts is a budget that grows.
 *
 * NO PHI: 12827 and 12828 are the designated roland fixtures.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootHygApp, api, perioOd, toothInitialRow } = require('./hygTestUtils');
const contract = require('../../hyg/contract.gen.cjs');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;
const BASE = '/api/hyg/visit/900001';
const PAT = 12827;

const perioFake = (opts) => perioOd({ date: DATE, patNum: PAT, ...opts });
const prior = (app) => api(app.baseUrl, 'GET', BASE + '/perio/prior' + Q);
const chartOf = (app) => api(app.baseUrl, 'GET', BASE + '/perio' + Q);

/** The five Missing rows 12828 measured — out of tooth order, ToothNum a string. */
const FIVE_MISSING = ['1', '16', '9', '32', '17'].map((toothNum, i) =>
  toothInitialRow({ num: 400 + i, patNum: PAT, toothNum })
);

/**
 * The CHART reads this route made since a mark.
 *
 * Resolving the appointment is five more reads (`/appointments`, `/operatories`,
 * `/appointmenttypes`, `/providers`, `/patients/:n`) that item 27 does not touch
 * and that the day view pays for anyway, so the budget is asserted over the
 * paths this slice is about — the same way item 14 asserted over `/perio*`.
 */
const CHART_READS = ['/perioexams', '/periomeasures', '/toothinitials'];
const since = (app, mark) =>
  app.od.calls.slice(mark).map((c) => c.path).filter((p) => CHART_READS.includes(p));

/** Open the visit and store a chart, so the visit is no longer untouched. */
async function storeChart(app, chart) {
  await api(app.baseUrl, 'POST', BASE + '/open' + Q);
  const put = await api(app.baseUrl, 'PUT', BASE + '/perio' + Q, { body: { chart } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  return put.body;
}

function preSkipAudits(app) {
  return app.db.audit.filter((r) => r.resource_type === 'hyg_perio_missing_teeth');
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 1 + 7: the fact, read from the measured shape
// ─────────────────────────────────────────────────────────────────────────────

test('ACCEPTANCE 1: the teeth Open Dental marks Missing come back parsed, sorted and deduped', async () => {
  const od = perioFake({ toothInitials: FIVE_MISSING });
  const app = await bootHygApp({ od: od.client });
  try {
    const res = await prior(app);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.preSkip.status, 'ready');
    // Open Dental sent "1","16","9","32","17" as STRINGS, in that order.
    assert.deepEqual(res.body.preSkip.teeth, [1, 9, 16, 17, 32]);
    for (const tooth of res.body.preSkip.teeth) assert.equal(typeof tooth, 'number');

    // And the contract the client parses with accepts it.
    const parsed = contract.HygPerioPriorResponseSchema.safeParse(res.body);
    assert.ok(parsed.success, JSON.stringify(parsed.error));
  } finally {
    await app.close();
  }
});

test('PatNum is always passed, so the whole-practice answer can never arrive', async () => {
  // Unfiltered this endpoint answered 100 rows across 28 PatNums (measured).
  const od = perioFake({ toothInitials: FIVE_MISSING });
  const app = await bootHygApp({ od: od.client });
  try {
    await prior(app);
    const asked = app.od.calls.filter((c) => c.path === '/toothinitials');
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].params, { PatNum: PAT });
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 4: `200 []` pre-skips nothing and is NOT an error; a failed read
// behaves exactly as today
// ─────────────────────────────────────────────────────────────────────────────

test('ACCEPTANCE 4a: a patient with no initials answers `ready` with no teeth — not an error', async () => {
  // The measured absence: HTTP 200 with []. This is the perioOd default.
  const od = perioFake();
  const app = await bootHygApp({ od: od.client });
  try {
    const res = await prior(app);
    assert.equal(res.status, 200, 'a patient with all their teeth is not a failure');
    assert.equal(res.body.preSkip.status, 'ready');
    assert.deepEqual(res.body.preSkip.teeth, []);
    // Nothing was disclosed about this patient's teeth, so nothing is recorded.
    assert.equal(preSkipAudits(app).length, 0);
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 4b: a FAILED initials read leaves the response exactly as it is today', async () => {
  const od = perioFake();
  od.client.routes['/toothinitials'] = {
    ok: false,
    status: 503,
    data: null,
    error: 'Service Unavailable',
  };
  const app = await bootHygApp({ od: od.client });
  try {
    const res = await prior(app);
    assert.equal(res.status, 200, 'the prior panel must not pay for the pre-skip');
    assert.equal(res.body.preSkip.status, 'unavailable');
    // The rest of the body is untouched — this is the fail-soft claim.
    assert.equal(res.body.prior.status, 'none');
    assert.equal(res.body.drift.status, 'not_applicable');
    assert.equal(res.body.success, true);
    // NOT A WORD, and no trail: a failed fetch disclosed nothing.
    assert.equal(preSkipAudits(app).length, 0);
    assert.ok(!('teeth' in res.body.preSkip), 'an unavailable answer names no teeth at all');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 4c: absence and failure are DIFFERENT answers, which is why the probe was run', async () => {
  /*
   * ONE APP AT A TIME. `bootHygApp` installs its Open Dental fake where the
   * office registry can find it, which is process-wide — two live apps and the
   * second one answers for both. Asked for by hand the first time this test was
   * written, and it reported the absent patient as `unavailable`.
   */
  const answers = {};
  for (const [name, route] of [
    ['absent', []],
    ['failing', { ok: false, status: 404, data: null, error: 'nope' }],
  ]) {
    const od = perioFake();
    od.client.routes['/toothinitials'] = route;
    const app = await bootHygApp({ od: od.client });
    try {
      answers[name] = (await prior(app)).body.preSkip.status;
    } finally {
      await app.close();
    }
  }
  assert.equal(answers.absent, 'ready', 'an empty list is an answer');
  assert.equal(answers.failing, 'unavailable', 'a refusal is not');
  assert.notEqual(answers.absent, answers.failing);
});

test('an initials read that THROWS is unavailable, and still answers the chart', async () => {
  const od = perioFake();
  const real = od.client.apiGetRaw.bind(od.client);
  od.client.apiGetRaw = async (path, params, opts) => {
    if (path === '/toothinitials') throw new Error('socket hang up');
    return real(path, params, opts);
  };
  const app = await bootHygApp({ od: od.client });
  try {
    const res = await prior(app);
    assert.equal(res.status, 200);
    assert.equal(res.body.preSkip.status, 'unavailable');
    assert.equal(res.body.success, true);
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 5: rows that must be ignored, and the one that must be counted
// ─────────────────────────────────────────────────────────────────────────────

test('ACCEPTANCE 5: a letter ToothNum and a wrong-PatNum row are ignored', async () => {
  const od = perioFake({
    toothInitials: [
      toothInitialRow({ num: 1, patNum: PAT, toothNum: '8' }),
      // A primary tooth. Not an error — v1 charts permanent dentition.
      toothInitialRow({ num: 2, patNum: PAT, toothNum: 'A' }),
      // Somebody else's missing tooth. This is the unfiltered-endpoint hazard.
      toothInitialRow({ num: 3, patNum: 12828, toothNum: '30' }),
      // A tooth that is THERE.
      toothInitialRow({ num: 4, patNum: PAT, toothNum: '14', initialType: 'Rotate' }),
    ],
  });
  const app = await bootHygApp({ od: od.client });
  try {
    const res = await prior(app);
    assert.equal(res.body.preSkip.status, 'ready');
    assert.deepEqual(res.body.preSkip.teeth, [8], 'only this patient’s missing permanent teeth');
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 5: a wrong-PatNum row is warned about ONCE, as a count, with no PatNum in it', async () => {
  const od = perioFake({
    toothInitials: [
      toothInitialRow({ num: 1, patNum: PAT, toothNum: '8' }),
      toothInitialRow({ num: 2, patNum: 12828, toothNum: '30' }),
      toothInitialRow({ num: 3, patNum: 99999, toothNum: '31' }),
    ],
  });
  const app = await bootHygApp({ od: od.client });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await prior(app);
    const mine = warnings.filter((w) => w.includes('/toothinitials'));
    assert.equal(mine.length, 1, 'one line, not one per row: ' + JSON.stringify(warnings));
    assert.match(mine[0], /2 row\(s\) for ANOTHER PatNum/);
    // A count is the whole point — the foreign PatNums themselves are PHI-ish
    // identifiers and must not be logged.
    assert.ok(!mine[0].includes('12828'), mine[0]);
    assert.ok(!mine[0].includes('99999'), mine[0]);
  } finally {
    console.warn = realWarn;
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 6: the request budget
// ─────────────────────────────────────────────────────────────────────────────

test('ACCEPTANCE 6: opening a FRESH chart costs exactly ONE added Open Dental request', async () => {
  const od = perioFake({ toothInitials: FIVE_MISSING });
  const app = await bootHygApp({ od: od.client });
  try {
    const mark = app.od.calls.length;
    const res = await prior(app);
    assert.equal(res.status, 200);

    /*
     * The prior panel was already two reads. Item 27 adds the third and no
     * more: `readMissingTeeth` makes a single GET and deliberately does not
     * page, so this list is the entire chart-open budget.
     */
    assert.deepEqual(since(app, mark), ['/perioexams', '/toothinitials']);
    assert.equal(
      since(app, mark).filter((p) => p === '/toothinitials').length,
      1,
      'one request for the initials — never a page loop'
    );
  } finally {
    await app.close();
  }
});

test('ACCEPTANCE 6: a chart that has already been STORED spends NOTHING on the initials', async () => {
  const od = perioFake({ toothInitials: FIVE_MISSING });
  const app = await bootHygApp({ od: od.client });
  try {
    let chart = contract.withPerioSite(contract.emptyPerioChart(), 3, 'DB', { depth: 4 });
    chart = contract.normalizePerioChart(chart);
    await storeChart(app, chart);

    const mark = app.od.calls.length;
    const res = await prior(app);
    assert.equal(res.status, 200);
    // A pre-skip could never apply to this chart, so the request is not made.
    assert.equal(since(app, mark).includes('/toothinitials'), false);
    assert.equal(res.body.preSkip.status, 'unavailable', 'not read is not an answer');
  } finally {
    await app.close();
  }
});

test('a chart stored EMPTY still spends nothing — she has been here, and that is what counts', async () => {
  /*
   * This is the un-skip-the-last-tooth case. The chart is empty but a row
   * exists, and treating it as untouched would re-skip the tooth she just
   * un-skipped. `chartStored` is the predicate precisely because `empty` is not.
   */
  const od = perioFake({ toothInitials: FIVE_MISSING });
  const app = await bootHygApp({ od: od.client });
  try {
    const stored = await storeChart(app, contract.emptyPerioChart());
    assert.equal(stored.counts.empty, true, 'an EMPTY chart...');
    assert.equal(stored.chartStored, true, '...that has nonetheless been stored');

    const mark = app.od.calls.length;
    const res = await prior(app);
    assert.equal(since(app, mark).includes('/toothinitials'), false);
    assert.equal(res.body.preSkip.status, 'unavailable');
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// `chartStored`, the marker the client gates on
// ─────────────────────────────────────────────────────────────────────────────

test('chartStored is false before any chart is stored and true forever after', async () => {
  const od = perioFake({ toothInitials: FIVE_MISSING });
  const app = await bootHygApp({ od: od.client });
  try {
    const fresh = await chartOf(app);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.chartStored, false, 'nobody has opened this chart');
    assert.equal(fresh.body.counts.empty, true);

    await storeChart(app, contract.emptyPerioChart());

    const after = await chartOf(app);
    assert.equal(after.body.chartStored, true);
    // The two really are different questions, and this is the case that proves it.
    assert.equal(after.body.counts.empty, true);
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The trail: naming teeth is the disclosure
// ─────────────────────────────────────────────────────────────────────────────

test('naming teeth writes ONE audit row; naming none writes nothing', async () => {
  const od = perioFake({ toothInitials: FIVE_MISSING });
  const app = await bootHygApp({ od: od.client });
  try {
    await prior(app);
    const rows = preSkipAudits(app);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.action, 'READ');
    assert.equal(row.result, 'SUCCESS');
    assert.equal(row.office, 'roland');
    assert.equal(Number(row.resource_id), 900001, 'the appointment, like every other perio row');
    // A pre-skip lands only on a chart nobody has touched, so it replaces no
    // decision anybody made. `prior_state` is for actions that do.
    assert.equal(row.prior_state ?? null, null);
    assert.equal(row.source_ref ?? null, null);
  } finally {
    await app.close();
  }
});

test('the existing prior-read trail is unchanged by all of this', async () => {
  const od = perioFake({ toothInitials: FIVE_MISSING });
  const app = await bootHygApp({ od: od.client });
  try {
    await prior(app);
    const types = app.db.audit.map((r) => r.resource_type);
    assert.ok(types.includes('hyg_perio_prior'));
    assert.ok(types.includes('hyg_perio_prior_patient'));
  } finally {
    await app.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Reads only
// ─────────────────────────────────────────────────────────────────────────────

test('the pre-skip reaches no Open Dental WRITE verb, on any of its paths', async () => {
  for (const initials of [
    FIVE_MISSING,
    [],
    [toothInitialRow({ num: 1, patNum: 12828, toothNum: '3' })],
  ]) {
    const od = perioFake({ toothInitials: initials });
    const app = await bootHygApp({ od: od.client });
    try {
      await prior(app);
      assert.deepEqual(od.client.writes, [], 'not one write verb');
      assert.deepEqual(od.state.posts, [], 'and nothing was posted');
      for (const call of app.od.calls.filter((c) => c.path === '/toothinitials')) {
        assert.deepEqual(call.params, { PatNum: PAT });
      }
    } finally {
      await app.close();
    }
  }
});
