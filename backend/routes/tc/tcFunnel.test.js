'use strict';

/**
 * GET /api/tc/reports/funnel — the route's contract around the SQL.
 *
 * WHAT THIS FILE DOES NOT PROVE: that the SQL is right. FakeTenantDb cannot run
 * a window function, a percentile or a regex — a fake database proves nothing
 * about SQL. The statements are executed against a real migrated Postgres by
 * scripts/tc-funnel-verify-queries.js (fixtures + hand-computed expectations).
 *
 * What this file DOES prove:
 *  - the gates: module entitlement, the tc.full role split, the office param;
 *  - window validation answers 400, never 500;
 *  - an office with no history answers 200 with zeros, null rates, a null
 *    coverageStartsAt and a coverage note;
 *  - every percentage is null on a zero denominator;
 *  - the WRITERS of status_change events (the status route and the hygiene
 *    claim) still produce the `<from> → <to>` shape the funnel parses. If
 *    someone rewords that description, this fails here instead of the funnel
 *    silently going blank.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootTcApp, api, auditRows, FakeTenantDb } = require('./tcTestUtils');
const funnel = require('./funnel');

/**
 * A fake DB that answers the funnel's statements with canned rows. The BOUNDS
 * statement is answered from its own parameters so window handling is real.
 */
function funnelDb({ coverage = null, rows = {} } = {}) {
  const db = new FakeTenantDb();
  db.onQuery(/AS span_days/, (_text, params) => {
    const [, from, to] = params;
    const toD = to || '2026-09-30';
    const fromD = from || '2025-10-01';
    const span = Math.round((Date.parse(toD) - Date.parse(fromD)) / 86400000) + 1;
    return {
      rows: [
        {
          from_date: fromD,
          to_date: toD,
          from_ts: new Date(`${fromD}T05:00:00Z`),
          to_ts: new Date(Date.parse(`${toD}T05:00:00Z`) + 86400000),
          span_days: span,
        },
      ],
    };
  });
  db.onQuery(/AS coverage_starts_at/, () => ({
    rows: [{ coverage_starts_at: coverage, reliable_entries: coverage ? 7 : 0 }],
  }));
  const named = [
    ['acceptance', /AS presented_value_cents/],
    ['wins', /won_value_cents\s+FROM wins w/],
    ['stages', /AS lost_after/],
    ['timeInStage', /AS p90_days/],
    ['weeks', /AS week_start,/],
    ['lost', /AS lost_cases/],
    ['byTc', /GROUP BY c\.assigned_tc/],
    ['byDoctor', /GROUP BY c\.doctor_name/],
    ['nurture', /AS reactivated_cases/],
  ];
  for (const [key, re] of named) db.onQuery(re, () => ({ rows: rows[key] || [] }));
  return db;
}

test('gates: module entitlement 403, hygiene role 403, office param 400', async () => {
  const unentitled = await bootTcApp({ modules: [], db: funnelDb() });
  try {
    const res = await api(unentitled.baseUrl, 'GET', '/api/tc/reports/funnel?office=roland');
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
  } finally {
    await unentitled.close();
  }

  const hygienist = await bootTcApp({ role: 'hygiene', db: funnelDb() });
  try {
    const res = await api(hygienist.baseUrl, 'GET', '/api/tc/reports/funnel?office=roland');
    assert.equal(res.status, 403, 'the funnel is tc.full, like every other report surface');
  } finally {
    await hygienist.close();
  }

  const { baseUrl, close } = await bootTcApp({ db: funnelDb() });
  try {
    for (const q of ['', '?office=', '?office=all', '?office=riley']) {
      const res = await api(baseUrl, 'GET', `/api/tc/reports/funnel${q}`);
      assert.equal(res.status, 400, q);
      assert.equal(res.body.code, 'INVALID_OFFICE');
    }
  } finally {
    await close();
  }
});

test('window validation answers 400 with a code, never 500', async () => {
  const { baseUrl, close } = await bootTcApp({ db: funnelDb() });
  try {
    const cases = [
      ['from=2026-9-1', 'INVALID_DATE'],
      ['to=yesterday', 'INVALID_DATE'],
      ['from=2026-02-30', 'INVALID_DATE'],
      ['from=2026-10-01&to=2026-09-01', 'INVALID_RANGE'],
      ['from=2024-01-01&to=2026-09-30', 'RANGE_TOO_LONG'],
    ];
    for (const [q, code] of cases) {
      const res = await api(baseUrl, 'GET', `/api/tc/reports/funnel?office=roland&${q}`);
      assert.equal(res.status, 400, `${q}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.success, false);
      assert.equal(res.body.code, code, q);
    }
  } finally {
    await close();
  }
});

test('an office with NO history: 200, zeros, null rates, null coverage, a coverage note', async () => {
  const { baseUrl, db, close } = await bootTcApp({ db: funnelDb() });
  try {
    const res = await api(baseUrl, 'GET', '/api/tc/reports/funnel?office=valley&from=2026-09-01&to=2026-09-30');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const f = res.body.funnel;
    assert.equal(f.office, 'valley');
    assert.equal(f.coverageStartsAt, null);
    assert.match(f.coverageNote, /No reliably recorded status changes yet/);
    assert.equal(f.acceptance.presentedCases, 0);
    assert.equal(f.acceptance.acceptanceRatePercent, null);
    assert.equal(f.acceptance.valueAcceptanceRatePercent, null);
    assert.equal(f.winLoss.winRatePercent, null);
    assert.deepEqual(
      f.stages.map((s) => s.status),
      funnel.BOARD_STAGES,
      'all 9 board stages are always present, in board order'
    );
    assert.ok(f.stages.every((s) => s.entered === 0 && s.conversionPercent === null && s.medianDays === null));

    // Every statement was scoped to the requested office.
    const funnelCalls = db.log.filter((l) => /FROM tc_case_events/.test(l.sql));
    assert.ok(funnelCalls.length >= 10);
    assert.ok(funnelCalls.every((l) => l.params[0] === 'valley'));
    // No SELECT * anywhere in what the route sent.
    assert.ok(db.log.every((l) => !/SELECT \*/i.test(l.sql)));

    // Audited like the case list — same action + resource type.
    const reads = auditRows(db).filter((r) => r.action === 'READ' && r.resource_type === 'tc_case');
    assert.equal(reads.length, 1);
  } finally {
    await close();
  }
});

test('populated rows are shaped, bigints become numbers, rates guard divide-by-zero', async () => {
  const db = funnelDb({
    coverage: new Date('2026-08-20T15:00:00Z'),
    rows: {
      acceptance: [
        { presented_cases: 4, accepted_cases: 2, presented_value_cents: '850000', accepted_value_cents: '700000' },
      ],
      wins: [{ won_cases: 4, won_value_cents: '1400000' }],
      stages: [{ status: 'presented', entered: 4, progressed: 2, lost_after: 1 }],
      timeInStage: [{ status: 'presented', completed_stays: 3, open_stays: 1, median_days: 4, p90_days: 3.99999 }],
      weeks: [{ week_start: '2026-08-31', won_cases: 1, won_value_cents: '200000' }],
      lost: [
        { lost_reason: 'moved', lost_cases: 1 },
        { lost_reason: null, lost_cases: 2 },
      ],
      byTc: [{ name: 'tc.b@fixture.invalid', presented_cases: 0, accepted_cases: 0, accepted_value_cents: '0' }],
      nurture: [{ reactivated_cases: 1, reactivated_value_cents: '400000' }],
    },
  });
  const { baseUrl, close } = await bootTcApp({ db });
  try {
    const res = await api(baseUrl, 'GET', '/api/tc/reports/funnel?office=roland&from=2026-08-01&to=2026-09-30');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const f = res.body.funnel;
    assert.equal(f.coverageStartsAt, '2026-08-20T15:00:00.000Z');
    assert.equal(f.window.clampedToCoverage, true, 'a window older than coverage is clamped');
    assert.equal(f.window.fromTs, '2026-08-20T15:00:00.000Z');
    assert.match(f.coverageNote, /first reliably recorded status change/);
    assert.deepEqual(f.acceptance, {
      presentedCases: 4,
      acceptedCases: 2,
      acceptanceRatePercent: 50,
      presentedValueCents: 850000,
      acceptedValueCents: 700000,
      valueAcceptanceRatePercent: 82.4,
    });
    const presented = f.stages.find((s) => s.status === 'presented');
    assert.deepEqual(presented, {
      status: 'presented',
      entered: 4,
      progressed: 2,
      lostAfter: 1,
      conversionPercent: 50,
      completedStays: 3,
      openStays: 1,
      medianDays: 4,
      p90Days: 4,
    });
    assert.deepEqual(f.winLoss.byLostReason, [
      { reason: 'moved', lostCases: 1 },
      { reason: null, lostCases: 2 },
    ]);
    assert.equal(f.winLoss.winRatePercent, 57.1); // 4 / (4 + 3)
    assert.deepEqual(f.byAssignedTc[0].acceptanceRatePercent, null, 'zero presented → null, not 0%');
    assert.deepEqual(f.acceptedByWeek, [{ weekStart: '2026-08-31', wonCases: 1, wonValueCents: 200000 }]);
    assert.deepEqual(f.nurtureReactivations, { cases: 1, valueCents: 400000 });
  } finally {
    await close();
  }
});

test('pct: null on a zero denominator, one decimal otherwise', () => {
  assert.equal(funnel.pct(0, 0), null);
  assert.equal(funnel.pct(5, 0), null);
  assert.equal(funnel.pct(0, 4), 0);
  assert.equal(funnel.pct(1, 3), 33.3);
  assert.equal(funnel.pct(2, 3), 66.7);
});

test('the funnel parses exactly the status_change shape the real writers produce', async () => {
  const pattern = new RegExp(funnel.TRANSITION_PATTERN);
  const { baseUrl, db, close } = await bootTcApp();
  try {
    // 1. POST /cases/:id/status — with and without a note.
    const created = await api(baseUrl, 'POST', '/api/tc/cases?office=roland', {
      patientName: 'Fixture Patient',
      category: 'implant',
      status: 'diagnosed',
      urgency: 'high',
      caseValueCents: 450000,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const caseId = created.body.case.caseId;
    const plain = await api(baseUrl, 'POST', `/api/tc/cases/${caseId}/status?office=roland`, { status: 'presented' });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    const noted = await api(baseUrl, 'POST', `/api/tc/cases/${caseId}/status?office=roland`, {
      status: 'accepted',
      note: 'signed: today → tomorrow',
    });
    assert.equal(noted.status, 200, JSON.stringify(noted.body));

    // 2. POST /hygiene-intakes/:id/claim.
    const intake = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=valley', {
      patientName: 'Fixture Hygiene Patient',
      diagnosingProvider: 'dr.fixture@fixture.invalid',
      category: 'single_tooth',
      urgency: 'medium',
      perioStatus: 'gingivitis',
      recallType: 'prophy',
      radiographs: ['BWX'],
      intraoralPhotosTaken: true,
      patientInterestLevel: 'warm',
      flagUrgent: false,
      chiefConcern: 'Fixture concern',
    });
    assert.equal(intake.status, 201, JSON.stringify(intake.body));
    const claimed = await api(
      baseUrl,
      'POST',
      `/api/tc/hygiene-intakes/${intake.body.case.caseId}/claim?office=valley`
    );
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));

    const changes = db.table('tc_case_events').filter((e) => e.type === 'status_change');
    const parsed = changes.map((e) => {
      const m = e.description.match(pattern);
      assert.ok(m, `unparseable status_change description: ${e.description}`);
      assert.equal(e.legacy_id, null, 'server-written events carry no legacy id');
      return [m[1], m[2]];
    });
    assert.deepEqual(parsed.sort(), [
      ['diagnosed', 'presented'],
      ['hygiene_review', 'pending_tc'],
      ['presented', 'accepted'],
    ]);
    for (const [from, to] of parsed) {
      assert.ok(funnel.CASE_STATUSES.includes(from) && funnel.CASE_STATUSES.includes(to));
    }
  } finally {
    await close();
  }
});

test('legacy (imported) status_change descriptions never parse as transitions', () => {
  const pattern = new RegExp(funnel.TRANSITION_PATTERN);
  // The two shapes the legacy TC app wrote (CasesContext.tsx).
  for (const d of ['Moved to presented', 'Moved to partially accepted', 'Accepted — moved forward']) {
    assert.equal(pattern.test(d), false, d);
  }
});

test('the server vocab mirrors the contract: statuses and lost reasons', () => {
  const contract = require('../../tc/contract.gen.cjs');
  assert.deepEqual([...funnel.CASE_STATUSES], contract.CaseStatus.options);
  assert.deepEqual([...funnel.LOST_REASONS], contract.LostReason.options);
  for (const s of [...funnel.BOARD_STAGES, ...funnel.ACCEPTED_FAMILY, ...funnel.REACTIVATION_OPEN]) {
    assert.ok(contract.CaseStatus.options.includes(s), s);
  }
  // Reactivation's middle step is OPEN and not nurture, by the contract's own partition.
  assert.deepEqual(
    [...funnel.REACTIVATION_OPEN].sort(),
    contract.OPEN_CASE_STATUSES.filter((s) => s !== 'nurture').sort()
  );
});
