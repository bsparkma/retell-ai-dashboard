#!/usr/bin/env node
'use strict';

/**
 * Run the TC conversion funnel's REAL statements against a REAL migrated tenant
 * schema, over synthetic fixtures, and hold every number to a hand-computed
 * expectation.
 *
 * WHY THIS EXISTS. The funnel is nine SQL statements of window functions,
 * percentiles, regex parsing of event descriptions, array slicing and
 * time-zone bucketing. The unit suite's FakeTenantDb cannot run a single one of
 * them — a fake database proves nothing about SQL. This script is the ground
 * truth: Postgres executes the exact text the route sends (routes/tc/funnel.js
 * computeFunnel) against the schema the migrations build.
 *
 * SAFE TO RUN ANYWHERE MIGRATED. Everything happens inside ONE transaction that
 * is always ROLLED BACK, and the script refuses to start if the database
 * already holds any tc_cases row (the empty-office fixture is only empty if
 * the database is) — so it can never read or disturb real data.
 *
 * FIXTURES ARE SYNTHETIC: "Fixture Patient A".. names, no PatNum, staff ids on
 * the .invalid TLD. The office keys are the frozen roland / valley.
 *
 * Usage (after `migrate.js up` + `migrate-tenant.js up --tenant carein`):
 *   MIGRATE_TENANT_DB_URL=postgres://... node scripts/tc-funnel-verify-queries.js
 */

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

const { computeFunnel } = require('../routes/tc/funnel');

const TZ = 'America/Chicago';
const TC_A = 'tc.a@fixture.invalid';
const TC_B = 'tc.b@fixture.invalid';
const DR_ONE = 'Dr. Fixture One';
const DR_TWO = 'Dr. Fixture Two';

/** 15:00Z = 10:00 CDT — far from any local-midnight boundary. */
const at = (day) => `2026-${day}T15:00:00Z`;

/**
 * Insert one case + its events. `events` are [type, isoTs, description, legacyId?].
 * Descriptions for server transitions use the exact routes/tc/cases.js shape.
 */
async function seedCase(db, c) {
  const caseId = randomUUID();
  await db.query(
    `INSERT INTO tc_cases (case_id, legacy_id, office_id, patient_name, category, status, urgency,
                           doctor_name, assigned_tc, case_value_cents, lost_reason, status_changed_at)
     VALUES ($1, $2, $3, $4, 'single_tooth', $5, 'medium', $6, $7, $8, $9, $10)`,
    [caseId, c.legacyId ?? null, c.office ?? 'roland', c.name, c.status, c.doctor ?? '', c.tc ?? '',
      c.valueCents, c.lostReason ?? null, c.events.length ? c.events[c.events.length - 1][1] : null]
  );
  for (const [type, ts, description, legacyId] of c.events) {
    await db.query(
      `INSERT INTO tc_case_events (event_id, case_id, office_id, ts, type, description, actor, detail, legacy_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)`,
      [randomUUID(), caseId, c.office ?? 'roland', ts, type, description, 'fixture@fixture.invalid', legacyId ?? null]
    );
  }
  return caseId;
}

const t = (from, to) => `${from} → ${to}`;

/** The fixture set. Expectations in steps() are computed by hand from these. */
async function seed(db) {
  // A — FULL HISTORY: created as diagnosed, walked to scheduled.
  await seedCase(db, {
    name: 'Fixture Patient A', status: 'scheduled', valueCents: 500000, tc: TC_A, doctor: DR_ONE,
    events: [
      ['case_created', at('09-01'), 'Case created'],
      ['status_change', at('09-02'), t('diagnosed', 'pending_tc')],
      ['status_change', at('09-04'), t('pending_tc', 'presented')],
      ['status_change', at('09-08'), `${t('presented', 'accepted')}: signed today`],
      ['status_change', at('09-15'), t('accepted', 'scheduled')],
    ],
  });
  // B — IMPORTED, legacy history in the legacy app's free-text shape (one with
  // an empty legacy id, which imports as legacy_id NULL), then one real
  // server transition after go-live.
  await seedCase(db, {
    name: 'Fixture Patient B', legacyId: 'fixture-legacy-b', status: 'accepted', valueCents: 300000, tc: TC_B, doctor: DR_TWO,
    events: [
      ['case_created', '2026-07-01T15:00:00Z', 'Case created', 'lgB1'],
      ['status_change', '2026-07-10T15:00:00Z', 'Moved to presented', 'lgB2'],
      ['status_change', '2026-07-12T15:00:00Z', 'Moved to considering', null],
      ['status_change', at('09-10'), t('considering', 'accepted')],
    ],
  });
  // C — REOPENED: created as presented, accepted, reopened, re-accepted.
  await seedCase(db, {
    name: 'Fixture Patient C', status: 'accepted', valueCents: 200000, tc: TC_A, doctor: DR_TWO,
    events: [
      ['case_created', at('09-03'), 'Case created'],
      ['status_change', at('09-05'), t('presented', 'accepted')],
      ['status_change', at('09-06'), t('accepted', 'considering')],
      ['status_change', at('09-09'), t('considering', 'accepted')],
    ],
  });
  // D — LOST: created as presented, lost (reason still on the row).
  await seedCase(db, {
    name: 'Fixture Patient D', status: 'lost', lostReason: 'moved', valueCents: 100000, tc: TC_B, doctor: DR_ONE,
    events: [
      ['case_created', at('09-03'), 'Case created'],
      ['status_change', at('09-07'), `${t('presented', 'lost')}: relocating`],
    ],
  });
  // E — NURTURE REACTIVATION, and the office's OLDEST reliable entry (08-20).
  await seedCase(db, {
    name: 'Fixture Patient E', status: 'accepted', valueCents: 400000, tc: TC_A, doctor: DR_ONE,
    events: [
      ['case_created', at('08-20'), 'Case created'],
      ['status_change', at('08-25'), t('considering', 'nurture')],
      ['nurture_enrolled', at('08-25'), 'Enrolled in nurture campaign'],
      ['status_change', at('09-11'), t('nurture', 'considering')],
      ['status_change', at('09-12'), t('considering', 'accepted')],
    ],
  });
  // F — presented in the window, accepted only AFTER it ends.
  await seedCase(db, {
    name: 'Fixture Patient F', status: 'accepted', valueCents: 50000, tc: TC_B, doctor: '',
    events: [
      ['case_created', at('09-20'), 'Case created'],
      ['status_change', at('10-02'), t('presented', 'accepted')],
    ],
  });
  // valley: deliberately NOTHING — the empty office.
}

const stage = (f, status) => f.stages.find((s) => s.status === status);

function steps(db) {
  const run = (office, from, to) => computeFunnel(db, { office, from, to, timeZone: TZ });
  return [
    {
      name: 'coverage starts at the oldest RELIABLE entry (not the imported 07-01 history)',
      run: async () => {
        const { funnel: f } = await run('roland', '2026-09-01', '2026-09-30');
        assert.equal(f.coverageStartsAt, '2026-08-20T15:00:00.000Z');
        assert.equal(f.window.clampedToCoverage, false);
        assert.equal(f.coverageNote, null);
        assert.equal(f.window.fromTs, '2026-09-01T05:00:00.000Z'); // local midnight, CDT
        assert.equal(f.window.toTs, '2026-10-01T05:00:00.000Z');
      },
    },
    {
      name: 'presented → accepted cohort: 4 presented, 2 accepted, count and value rates',
      run: async () => {
        const { funnel: f } = await run('roland', '2026-09-01', '2026-09-30');
        assert.deepEqual(f.acceptance, {
          presentedCases: 4, // A, C, D, F — B (imported) has no reliable presented entry
          acceptedCases: 2, // A, C — D lost, F accepted after the window
          acceptanceRatePercent: 50,
          presentedValueCents: 850000,
          acceptedValueCents: 700000,
          valueAcceptanceRatePercent: 82.4,
        });
      },
    },
    {
      name: 'wins credited ONCE at first acceptance (reopened C counts once); lost by reason',
      run: async () => {
        const { funnel: f } = await run('roland', '2026-09-01', '2026-09-30');
        assert.deepEqual(f.winLoss, {
          wonCases: 4, // A, B, C, E
          wonValueCents: 1400000,
          lostCases: 1,
          winRatePercent: 80,
          byLostReason: [{ reason: 'moved', lostCases: 1 }],
        });
        assert.deepEqual(f.nurtureReactivations, { cases: 1, valueCents: 400000 });
      },
    },
    {
      name: 'accepted value by week: Monday buckets in the office time zone, zero-filled',
      run: async () => {
        const { funnel: f } = await run('roland', '2026-09-01', '2026-09-30');
        assert.deepEqual(f.acceptedByWeek, [
          { weekStart: '2026-08-31', wonCases: 1, wonValueCents: 200000 },
          { weekStart: '2026-09-07', wonCases: 3, wonValueCents: 1200000 },
          { weekStart: '2026-09-14', wonCases: 0, wonValueCents: 0 },
          { weekStart: '2026-09-21', wonCases: 0, wonValueCents: 0 },
          { weekStart: '2026-09-28', wonCases: 0, wonValueCents: 0 },
        ]);
      },
    },
    {
      name: 'stage conversion over the 9 board stages',
      run: async () => {
        const { funnel: f } = await run('roland', '2026-09-01', '2026-09-30');
        assert.deepEqual(
          f.stages.map((s) => [s.status, s.entered, s.progressed, s.lostAfter, s.conversionPercent]),
          [
            ['diagnosed', 1, 1, 0, 100],
            ['pending_tc', 1, 1, 0, 100],
            ['pending_pt', 0, 0, 0, null],
            ['presented', 4, 2, 1, 50],
            ['considering', 2, 2, 0, 100],
            ['financing_pending', 0, 0, 0, null],
            ['accepted', 4, 1, 0, 25],
            ['partially_accepted', 0, 0, 0, null],
            ['scheduled', 1, 0, 0, 0],
          ]
        );
      },
    },
    {
      name: 'days in stage: median + p90 over completed stays; open stays counted, not timed',
      run: async () => {
        const { funnel: f } = await run('roland', '2026-09-01', '2026-09-30');
        const pick = (s) => [s.completedStays, s.openStays, s.medianDays, s.p90Days];
        assert.deepEqual(pick(stage(f, 'diagnosed')), [1, 0, 1, 1]);
        assert.deepEqual(pick(stage(f, 'pending_tc')), [1, 0, 2, 2]);
        assert.deepEqual(pick(stage(f, 'presented')), [3, 1, 4, 4]); // [2,4,4]; F still open at window end
        assert.deepEqual(pick(stage(f, 'considering')), [2, 0, 2, 2.8]); // [1,3]
        assert.deepEqual(pick(stage(f, 'accepted')), [2, 3, 4, 6.4]); // [1,7]; B, C(2nd), E open
        assert.deepEqual(pick(stage(f, 'scheduled')), [0, 1, null, null]);
        assert.deepEqual(pick(stage(f, 'pending_pt')), [0, 0, null, null]);
      },
    },
    {
      name: 'by assigned TC and by doctor (cohort-based)',
      run: async () => {
        const { funnel: f } = await run('roland', '2026-09-01', '2026-09-30');
        assert.deepEqual(f.byAssignedTc, [
          { name: TC_A, presentedCases: 2, acceptedCases: 2, acceptedValueCents: 700000, acceptanceRatePercent: 100 },
          { name: TC_B, presentedCases: 2, acceptedCases: 0, acceptedValueCents: 0, acceptanceRatePercent: 0 },
        ]);
        assert.deepEqual(f.byDoctor, [
          { name: DR_ONE, presentedCases: 2, acceptedCases: 1, acceptedValueCents: 500000, acceptanceRatePercent: 50 },
          { name: DR_TWO, presentedCases: 1, acceptedCases: 1, acceptedValueCents: 200000, acceptanceRatePercent: 100 },
          { name: '', presentedCases: 1, acceptedCases: 0, acceptedValueCents: 0, acceptanceRatePercent: 0 },
        ]);
      },
    },
    {
      name: 'a window reaching before coverage is CLAMPED to it and says so',
      run: async () => {
        const { funnel: f } = await run('roland', '2026-08-01', '2026-09-30');
        assert.equal(f.window.clampedToCoverage, true);
        assert.equal(f.window.requestedFrom, '2026-08-01');
        assert.equal(f.window.fromTs, '2026-08-20T15:00:00.000Z');
        assert.match(f.coverageNote, /first reliably recorded status change/);
        // E's first considering stay (08-20 → 08-25, 5 days) is now inside.
        assert.equal(stage(f, 'considering').completedStays, 3);
      },
    },
    {
      name: 'reopen rule: C (accepted → considering → accepted) is ONE acceptance and ONE win',
      run: async () => {
        // 09-03 .. 09-05 local holds C's first acceptance, plus D's creation
        // (09-03) and A's presentation (09-04, accepted only on 09-08).
        const { funnel: f } = await run('roland', '2026-09-03', '2026-09-05');
        assert.equal(f.acceptance.presentedCases, 3); // A, C, D
        assert.equal(f.acceptance.acceptedCases, 1); // C, once
        assert.equal(f.winLoss.wonCases, 1);
        const later = (await run('roland', '2026-09-08', '2026-09-30')).funnel;
        // C's RE-acceptance on 09-09 is not a second win.
        assert.equal(later.winLoss.wonCases, 3); // A, B, E
      },
    },
    {
      name: 'EMPTY office: zeros, null rates, null coverage + a coverage note — not an error',
      run: async () => {
        const result = await run('valley', '2026-09-01', '2026-09-30');
        assert.equal(result.error, undefined);
        const f = result.funnel;
        assert.equal(f.coverageStartsAt, null);
        assert.match(f.coverageNote, /No reliably recorded status changes yet/);
        assert.equal(f.reliableEntries, 0);
        assert.equal(f.acceptance.presentedCases, 0);
        assert.equal(f.acceptance.acceptanceRatePercent, null);
        assert.equal(f.acceptance.valueAcceptanceRatePercent, null);
        assert.equal(f.winLoss.winRatePercent, null);
        assert.deepEqual(f.winLoss.byLostReason, []);
        assert.equal(f.stages.length, 9);
        assert.ok(f.stages.every((s) => s.entered === 0 && s.conversionPercent === null && s.medianDays === null));
        assert.equal(f.acceptedByWeek.length, 5);
        assert.ok(f.acceptedByWeek.every((w) => w.wonCases === 0 && w.wonValueCents === 0));
        assert.deepEqual(f.byAssignedTc, []);
        assert.deepEqual(f.nurtureReactivations, { cases: 0, valueCents: 0 });
      },
    },
    {
      name: 'office isolation: roland fixtures never leak into valley, and vice versa',
      run: async () => {
        const v = (await run('valley', '2026-08-01', '2026-10-31')).funnel;
        assert.equal(v.reliableEntries, 0);
      },
    },
    {
      name: 'window validation: from after to, and a window longer than 366 days, refuse',
      run: async () => {
        const tooLong = await run('roland', '2025-01-01', '2026-09-30');
        assert.equal(tooLong.error.code, 'RANGE_TOO_LONG');
        const inverted = await run('roland', '2026-10-01', '2026-09-30');
        assert.equal(inverted.error.code, 'INVALID_RANGE');
      },
    },
  ];
}

async function main() {
  const url = process.env.MIGRATE_TENANT_DB_URL || process.env.TENANT_DB_URL;
  if (!url) {
    console.error('[tc-funnel-verify-queries] set MIGRATE_TENANT_DB_URL to a MIGRATED tenant database');
    process.exit(2);
  }
  const client = new Client({ connectionString: url });
  await client.connect();

  const failures = [];
  let ran = 0;
  try {
    const existing = await client.query('SELECT COUNT(*)::int AS n FROM tc_cases');
    if (existing.rows[0].n !== 0) {
      console.error(
        `[tc-funnel-verify-queries] refusing: tc_cases already holds ${existing.rows[0].n} row(s). ` +
          'Run this against an EMPTY migrated tenant database only.'
      );
      process.exit(2);
    }
    // ONE TRANSACTION, ALWAYS ROLLED BACK — the fixtures never outlive the run.
    await client.query('BEGIN');
    await seed(client);
    for (const step of steps(client)) {
      try {
        await step.run();
        ran += 1;
        console.log(`  ok   ${step.name}`);
      } catch (err) {
        failures.push(`${step.name}: ${err.message}`);
        console.log(`  FAIL ${step.name}: ${err.message}`);
      }
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    const left = await client.query('SELECT COUNT(*)::int AS n FROM tc_cases').catch(() => null);
    if (left) console.log(`  (rolled back; tc_cases rows left behind: ${left.rows[0].n})`);
    await client.end().catch(() => {});
  }

  if (failures.length) {
    console.error(`\n[tc-funnel-verify-queries] ${failures.length} step(s) failed against the migrated schema:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\n[tc-funnel-verify-queries] ${ran} funnel check(s) passed against the migrated schema`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[tc-funnel-verify-queries] failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { steps, seed };
