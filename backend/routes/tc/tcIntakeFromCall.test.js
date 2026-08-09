'use strict';

/**
 * POST /api/tc/cases/from-call — the voice → TC handoff intake.
 *
 * Covers the five laws the frozen contract fixes: strict contract rejection,
 * the create path, the attach path (including the most-recently-active
 * tiebreak and the terminal-status exclusions), idempotency on call_id,
 * entitlement, and the valley office.
 *
 * NOT covered here, deliberately: the UNIQUE index on
 * tc_case_events.source_call_id. That guarantee lives in Postgres, and the
 * in-memory harness has no unique indexes and no real transactions — asserting
 * it here would prove the fake, not the schema. What IS covered is the route's
 * own handling of the violation (the 23505 branch), driven by an injected
 * failure. The index itself is exercised by the migration + spine smoke test.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const PATH = '/api/tc/cases/from-call';

const HANDOFF = Object.freeze({
  od_patient_id: 7115,
  office: 'roland',
  call_id: 'mango_call_0001',
  patient_name: 'Handoff Test',
  patient_phone: '+15550100',
  call_summary: 'Caller asked about replacing a missing back tooth and the cost.',
  call_url: '/calls/mango_call_0001',
});

/** Seed a case row directly, bypassing the API (which cannot set timestamps). */
function seedCase(db, overrides) {
  const row = {
    case_id: overrides.case_id,
    legacy_id: null,
    office_id: 'roland',
    patient_name: 'Seeded Patient',
    patient_age: null,
    phone: null,
    email: null,
    od_patient_id: 7115,
    case_type: '',
    category: 'implant',
    status: 'diagnosed',
    urgency: 'medium',
    doctor_name: '',
    diagnosing_provider: null,
    assigned_tc: '',
    case_value_cents: 0,
    readiness_score: 0,
    financing_status: '',
    preferred_financing_provider: null,
    decision_makers: '',
    financial_situation: [],
    key_motivators: [],
    contact_preference: null,
    best_time_to_reach: '',
    notes: '',
    referral_source: null,
    lost_reason: null,
    diagnosed_date: null,
    status_changed_at: null,
    nurture_cadence: 'standard',
    in_long_tail_mode: false,
    nurture_enrolled_at: null,
    nurture_phase_changed_at: null,
    nurture_phase1_days_override: null,
    nurture_phase2_days_override: null,
    nurture_unsubscribed: false,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
  db.table('tc_cases').push(row);
  return row;
}

function handoffEvents(db) {
  return db.table('tc_case_events').filter((e) => e.type === 'voice_handoff');
}

// ── 1. Contract rejection ───────────────────────────────────────────────────

test('contract rejection: missing patient_name, bad office, unknown keys → 400', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const { patient_name, ...noName } = HANDOFF;
    const bad = [
      ['missing patient_name', noName],
      ['empty patient_name', { ...HANDOFF, patient_name: '' }],
      ['missing od_patient_id', { ...HANDOFF, od_patient_id: undefined }],
      ['non-integer od_patient_id', { ...HANDOFF, od_patient_id: 71.15 }],
      ['unknown office', { ...HANDOFF, office: 'riley' }],
      ['missing office', { ...HANDOFF, office: undefined }],
      ['empty call_id', { ...HANDOFF, call_id: '' }],
      ['unknown key', { ...HANDOFF, patientName: 'Camel Case' }],
      ['actor from the body is not accepted', { ...HANDOFF, actor: 'someone@else.com' }],
    ];
    for (const [label, body] of bad) {
      const res = await api(baseUrl, 'POST', PATH, body);
      assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'VALIDATION_FAILED', label);
    }
    // A rejected contract writes nothing at all — no case, no event, no audit.
    assert.equal(db.table('tc_cases').length, 0);
    assert.equal(db.table('tc_case_events').length, 0);
    assert.equal(auditRows(db).length, 0);
  } finally {
    await close();
  }
});

// ── 2. Create path ──────────────────────────────────────────────────────────

test('create path: opens a pending_tc case assigned to the actor, with a voice_handoff event', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const res = await api(baseUrl, 'POST', PATH, HANDOFF);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.attached, false);
    assert.equal(res.body.url, `/tc/cases/${res.body.case_id}`);
    assert.ok(res.body.case_id, 'response must carry the persisted case id');

    const rows = db.table('tc_cases');
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.case_id, res.body.case_id, 'response id must be the persisted id');
    assert.equal(row.status, 'pending_tc');
    assert.equal(row.assigned_tc, 'tc@carein.ai', 'assigned to the SSO actor, not a body field');
    assert.equal(row.diagnosing_provider, null);
    assert.equal(row.office_id, 'roland');
    assert.equal(row.od_patient_id, 7115);
    // Snapshot, not a lookup: TC can name the case without touching OD.
    assert.equal(row.patient_name, 'Handoff Test');
    assert.equal(row.phone, '+15550100');

    // The durable artifact.
    const events = handoffEvents(db);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.case_id, res.body.case_id);
    assert.equal(event.office_id, 'roland');
    assert.equal(event.actor, 'tc@carein.ai');
    assert.equal(event.source_call_id, 'mango_call_0001');
    assert.equal(event.detail.callSummary, HANDOFF.call_summary);
    assert.equal(event.detail.callUrl, '/calls/mango_call_0001');
    assert.equal(event.detail.attached, false);
    // ...alongside the ordinary case_created event, so the case looks like any other.
    assert.ok(db.table('tc_case_events').some((e) => e.type === 'case_created'));

    // Audit: one row, CREATE, stamped with office + the call that caused it.
    const audits = auditRows(db);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'CREATE');
    assert.equal(audits[0].resource_type, 'tc_case');
    assert.equal(audits[0].resource_id, res.body.case_id);
    assert.equal(audits[0].user_id, 'tc@carein.ai');
    assert.equal(audits[0].office, 'roland');
    assert.equal(audits[0].source_ref, 'mango_call_0001');
  } finally {
    await close();
  }
});

test('create path: optional snapshot fields may be absent or null', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const res = await api(baseUrl, 'POST', PATH, {
      od_patient_id: 7115,
      office: 'roland',
      call_id: 'mango_call_bare',
      patient_name: 'Bare Handoff',
      call_summary: null,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(db.table('tc_cases')[0].phone, null);
    const event = handoffEvents(db)[0];
    assert.equal(event.detail.callSummary, null);
    assert.equal(event.detail.callUrl, null);
  } finally {
    await close();
  }
});

// ── 3. Attach path ──────────────────────────────────────────────────────────

test('attach path: an open case takes the handoff and is not overwritten', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    seedCase(db, { case_id: 'c-open', status: 'considering', patient_name: 'Seeded Patient' });

    const res = await api(baseUrl, 'POST', PATH, HANDOFF);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.attached, true);
    assert.equal(res.body.case_id, 'c-open');
    assert.equal(res.body.url, '/tc/cases/c-open');

    // No second case, and the live case's own data wins over the call snapshot.
    assert.equal(db.table('tc_cases').length, 1);
    assert.equal(db.table('tc_cases')[0].patient_name, 'Seeded Patient');
    assert.equal(db.table('tc_cases')[0].status, 'considering');

    const events = handoffEvents(db);
    assert.equal(events.length, 1);
    assert.equal(events[0].case_id, 'c-open');
    assert.equal(events[0].detail.attached, true);
    assert.equal(events[0].detail.callSummary, HANDOFF.call_summary);
    // No case_created event — nothing was created.
    assert.equal(db.table('tc_case_events').filter((e) => e.type === 'case_created').length, 0);

    const audits = auditRows(db);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'UPDATE', 'attach audits as UPDATE, not CREATE');
    assert.equal(audits[0].resource_id, 'c-open');
    assert.equal(audits[0].source_ref, 'mango_call_0001');
  } finally {
    await close();
  }
});

test('attach path: picks the MOST RECENTLY ACTIVE open case', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    seedCase(db, {
      case_id: 'c-stale',
      status: 'presented',
      updated_at: new Date('2026-02-01T00:00:00.000Z'),
    });
    seedCase(db, {
      case_id: 'c-recent',
      status: 'financing_pending',
      updated_at: new Date('2026-06-01T00:00:00.000Z'),
    });
    seedCase(db, {
      case_id: 'c-middle',
      status: 'nurture',
      updated_at: new Date('2026-03-01T00:00:00.000Z'),
    });

    const res = await api(baseUrl, 'POST', PATH, HANDOFF);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.attached, true);
    assert.equal(res.body.case_id, 'c-recent');
  } finally {
    await close();
  }
});

test('attach path: terminal-status cases are never attached to', async () => {
  const TERMINAL = ['accepted', 'partially_accepted', 'scheduled', 'started', 'completed', 'lost'];
  for (const status of TERMINAL) {
    const { baseUrl, db, close } = await bootTcApp();
    try {
      seedCase(db, { case_id: `c-${status}`, status });

      const res = await api(baseUrl, 'POST', PATH, HANDOFF);
      assert.equal(res.status, 200, `${status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.attached, false, `${status} must not be attached to`);
      assert.notEqual(res.body.case_id, `c-${status}`);
      assert.equal(db.table('tc_cases').length, 2, `${status}: a new case must be opened`);
    } finally {
      await close();
    }
  }
});

test('attach path: every open status IS attached to', async () => {
  const OPEN = [
    'hygiene_review',
    'diagnosed',
    'pending_tc',
    'pending_pt',
    'presented',
    'considering',
    'financing_pending',
    'nurture',
  ];
  for (const status of OPEN) {
    const { baseUrl, db, close } = await bootTcApp();
    try {
      seedCase(db, { case_id: `c-${status}`, status });

      const res = await api(baseUrl, 'POST', PATH, HANDOFF);
      assert.equal(res.status, 200, `${status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.attached, true, `${status} is open and must take the handoff`);
      assert.equal(res.body.case_id, `c-${status}`);
    } finally {
      await close();
    }
  }
});

test('attach path: scoping — another office or another patient is not a match', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    seedCase(db, { case_id: 'c-valley', office_id: 'valley', status: 'considering' });
    seedCase(db, { case_id: 'c-other-pat', od_patient_id: 9999, status: 'considering' });

    const res = await api(baseUrl, 'POST', PATH, HANDOFF);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.attached, false, 'PatNum 7115 in valley is a different person');
    assert.equal(db.table('tc_cases').length, 3);
    assert.equal(db.table('tc_cases')[2].office_id, 'roland');
  } finally {
    await close();
  }
});

// ── 4. Idempotency ──────────────────────────────────────────────────────────

test('idempotency: the same call_id twice → same case, no duplicate event or audit row', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const first = await api(baseUrl, 'POST', PATH, HANDOFF);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.attached, false);

    const second = await api(baseUrl, 'POST', PATH, HANDOFF);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(second.body, first.body, 'a replay returns the first result verbatim');

    assert.equal(db.table('tc_cases').length, 1, 'no duplicate case');
    assert.equal(handoffEvents(db).length, 1, 'no duplicate event');
    // Log-once: the replay did no work, so recording a second mutation would be
    // recording something that did not happen.
    assert.equal(auditRows(db).length, 1, 'no duplicate audit row');
  } finally {
    await close();
  }
});

test('idempotency: a replayed ATTACH still reports attached:true', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    seedCase(db, { case_id: 'c-open', status: 'considering' });

    const first = await api(baseUrl, 'POST', PATH, HANDOFF);
    assert.equal(first.body.attached, true);

    // The case is closed after the fact — the replay must still report what
    // ACTUALLY happened, not re-decide it against today's status.
    db.table('tc_cases')[0].status = 'lost';

    const second = await api(baseUrl, 'POST', PATH, HANDOFF);
    assert.deepEqual(second.body, first.body);
    assert.equal(second.body.attached, true);
    assert.equal(handoffEvents(db).length, 1);
    assert.equal(auditRows(db).length, 1);
  } finally {
    await close();
  }
});

test('idempotency: a DIFFERENT call on the same patient attaches to the case the first one made', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const first = await api(baseUrl, 'POST', PATH, HANDOFF);
    assert.equal(first.body.attached, false);

    const second = await api(baseUrl, 'POST', PATH, { ...HANDOFF, call_id: 'mango_call_0002' });
    assert.equal(second.body.attached, true, 'the case the first handoff opened is open');
    assert.equal(second.body.case_id, first.body.case_id);

    assert.equal(db.table('tc_cases').length, 1);
    assert.equal(handoffEvents(db).length, 2, 'two calls, two timeline entries');
    assert.equal(auditRows(db).length, 2);
  } finally {
    await close();
  }
});

test('idempotency: a lost race on call_id replays the winner instead of 500-ing', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    // The winner's committed handoff, as it would look to the loser's retry.
    db.table('tc_case_events').push({
      event_id: 'e-winner',
      case_id: 'c-winner',
      office_id: 'roland',
      ts: new Date().toISOString(),
      type: 'voice_handoff',
      description: 'Sent to TC from a CareIN call — new case',
      actor: 'other@carein.ai',
      detail: { callUrl: null, callSummary: null, attached: false },
      legacy_id: null,
      source_call_id: 'race_call',
      created_at: new Date(),
      updated_at: new Date(),
    });

    // ...but hidden from the pre-flight replay read, so the route commits to
    // the write path and only then hits the unique violation.
    let hidden = true;
    db.onQuery(/SELECT case_id, detail FROM tc_case_events/i, (_text, qParams) => {
      if (hidden && qParams[0] === 'race_call') {
        hidden = false; // the winner becomes visible on the post-violation retry
        return { rows: [] };
      }
      return {
        rows: db
          .table('tc_case_events')
          .filter((e) => e.source_call_id === qParams[0])
          .map((e) => ({ case_id: e.case_id, detail: e.detail })),
      };
    });
    db.onQuery(/INSERT INTO tc_case_events/i, () => {
      const err = new Error('duplicate key value violates unique constraint');
      err.code = '23505';
      throw err;
    });

    const res = await api(baseUrl, 'POST', PATH, { ...HANDOFF, call_id: 'race_call' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.case_id, 'c-winner');
    assert.equal(res.body.attached, false);
    // The loser recorded nothing: the winner already audited this call.
    assert.equal(auditRows(db).length, 0);
  } finally {
    await close();
  }
});

// ── 5. Entitlement + office law ─────────────────────────────────────────────

test('requireModule: a tenant without the tc module gets 403 and writes nothing', async () => {
  const { baseUrl, db, close } = await bootTcApp({ modules: ['voice'] });
  try {
    const res = await api(baseUrl, 'POST', PATH, HANDOFF);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
    assert.equal(res.body.module, 'tc');
    assert.equal(db.table('tc_cases').length, 0);
    assert.equal(db.table('tc_case_events').length, 0);
  } finally {
    await close();
  }
});

test('valley handoffs create cases normally (OD gating is a separate concern)', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const res = await api(baseUrl, 'POST', PATH, {
      ...HANDOFF,
      office: 'valley',
      call_id: 'mango_call_valley',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.attached, false);

    const row = db.table('tc_cases')[0];
    assert.equal(row.office_id, 'valley');
    assert.equal(row.status, 'pending_tc');
    assert.equal(handoffEvents(db)[0].office_id, 'valley');
    assert.equal(auditRows(db)[0].office, 'valley');
  } finally {
    await close();
  }
});

test('office comes from the body and is honoured — a roland case never takes a valley handoff', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    seedCase(db, { case_id: 'c-roland', status: 'considering' });

    const res = await api(baseUrl, 'POST', PATH, {
      ...HANDOFF,
      office: 'valley',
      call_id: 'mango_call_valley',
    });
    assert.equal(res.body.attached, false);
    assert.notEqual(res.body.case_id, 'c-roland');
    assert.equal(db.table('tc_cases').find((c) => c.case_id === res.body.case_id).office_id, 'valley');
  } finally {
    await close();
  }
});

// ── 6. The case aggregate still reads back ──────────────────────────────────

test('the handoff event surfaces on the case aggregate GET (Activity tab)', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    const created = await api(baseUrl, 'POST', PATH, HANDOFF);
    const fetched = await api(
      baseUrl,
      'GET',
      `/api/tc/cases/${created.body.case_id}?office=roland`
    );
    assert.equal(fetched.status, 200, JSON.stringify(fetched.body));

    const event = fetched.body.case.events.find((e) => e.type === 'voice_handoff');
    assert.ok(event, 'the aggregate must parse a voice_handoff event through the contract');
    assert.equal(event.sourceCallId, 'mango_call_0001');
    assert.equal(event.detail.callSummary, HANDOFF.call_summary);
    assert.equal(event.detail.callUrl, '/calls/mango_call_0001');
    assert.equal(event.detail.attached, false);
    assert.equal(event.actor, 'tc@carein.ai');
  } finally {
    await close();
  }
});
