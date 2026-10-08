'use strict';

/**
 * /api/tc/opportunities (item 41) — the inbox routes, over the real TC stack
 * (tenantContext + requireModule('tc') + tc.full) and FakeTenantDb.
 *
 * Synthetic fixtures only: roland 12827 / 12828, valley 7115.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const { bootTcApp, api, auditRows } = require('./tcTestUtils');
const { OPEN_CASE_STATUSES, TERMINAL_CASE_STATUSES } = require('../../tc/contract.gen.cjs');

const PROCS = [
  { procNum: 501, code: 'D2740', description: 'crown - porcelain/ceramic', feeCents: 120000, tooth: '3', surf: '', plannedDate: '2026-08-15' },
  { procNum: 502, code: 'D3330', description: 'endodontic therapy, molar', feeCents: 110050, tooth: '3', surf: '', plannedDate: '2026-08-15' },
];

function seedOpp(db, over = {}) {
  const row = {
    opportunity_id: randomUUID(),
    office_id: 'roland',
    od_patient_id: 12827,
    patient_name: 'Test 2, Stedi',
    patient_phone: '(555) 010-0001',
    patient_status: 'Patient',
    procedures: PROCS,
    value_cents: 230050,
    planned_date: '2026-08-15',
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

function seedCase(db, over = {}) {
  const row = {
    case_id: randomUUID(),
    office_id: 'roland',
    od_patient_id: 12827,
    patient_name: 'Test 2, Stedi',
    status: 'presented',
    created_at: new Date('2026-09-01T00:00:00Z'),
    updated_at: new Date('2026-09-02T00:00:00Z'),
    ...over,
  };
  db.table('tc_cases').push(row);
  return row;
}

/** The phase tree odPlan.ts would build for PROCS (urgent endo, restorative crown). */
const PHASES = [
  {
    position: 0,
    name: 'Phase 1 — Urgent Treatment',
    description: 'Address urgent and high-priority conditions first',
    items: [
      { position: 0, odProcNum: 502, tooth: '3', procedureName: 'Root canal — molar', feeCents: 110050, insuranceEstCents: 0, patientPortionCents: 110050, urgency: 'high' },
    ],
  },
  {
    position: 1,
    name: 'Phase 2 — Restorative',
    description: 'Restore function and prevent further damage',
    items: [
      { position: 0, odProcNum: 501, tooth: '3', procedureName: 'Crown — porcelain/ceramic', feeCents: 120000, insuranceEstCents: 0, patientPortionCents: 120000, urgency: 'medium' },
    ],
  },
];

test('GET lists new rows for the office with totals + honest sync state, and audits a READ', async () => {
  const app = await bootTcApp();
  try {
    seedOpp(app.db);
    seedOpp(app.db, { od_patient_id: 12828, patient_name: 'Test, MangoTest', value_cents: 50000 });
    seedOpp(app.db, { office_id: 'valley', od_patient_id: 7115, patient_name: 'TestValley, Stedi' });
    seedOpp(app.db, { od_patient_id: 990001, patient_status: 'Inactive' });
    seedOpp(app.db, { od_patient_id: 990002, cleared_at: new Date() });
    app.db.table('tc_opportunity_sync').push({
      office_id: 'roland',
      last_synced_at: new Date('2026-10-08T07:41:00Z'),
      last_attempt_at: new Date('2026-10-08T07:41:00Z'),
      last_status: 'ok',
      last_error: null,
      procedures_scanned: 4210,
      patients: 3,
      names_pending: 0,
    });
    const r = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.opportunities.map((o) => o.odPatientId).sort(), [12827, 12828]);
    assert.deepEqual(r.body.totals, { count: 2, valueCents: 280050 });
    assert.equal(r.body.sync.lastStatus, 'ok');
    assert.equal(r.body.sync.lastSyncedAt, '2026-10-08T07:41:00.000Z');
    for (const o of r.body.opportunities) assert.equal(o.officeId, 'roland', 'PatNum travels with its office');
    const audit = auditRows(app.db).filter((a) => a.resource_type === 'tc_opportunity');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'READ');
  } finally {
    await app.close();
  }
});

test('GET: never-synced office says so (sync null), status filter validated', async () => {
  const app = await bootTcApp();
  try {
    const r = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=valley');
    assert.equal(r.status, 200);
    assert.equal(r.body.sync, null);
    assert.deepEqual(r.body.totals, { count: 0, valueCents: 0 });
    const bad = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland&status=resolved');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_STATUS');
    const noOffice = await api(app.baseUrl, 'GET', '/api/tc/opportunities');
    assert.equal(noOffice.status, 400);
  } finally {
    await app.close();
  }
});

test('GET reconciles existing_case BOTH directions against open cases (same office only)', async () => {
  const app = await bootTcApp();
  try {
    const opp = seedOpp(app.db);
    const c = seedCase(app.db);
    seedCase(app.db, { office_id: 'valley', od_patient_id: 12828 }); // other office
    const other = seedOpp(app.db, { od_patient_id: 12828 });
    let r = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland&status=existing_case');
    assert.deepEqual(r.body.opportunities.map((o) => o.opportunityId), [opp.opportunity_id]);
    assert.equal(other.status, 'new');
    c.status = 'lost';
    r = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland');
    assert.equal(opp.status, 'new');
    assert.equal(r.body.totals.count, 2);
  } finally {
    await app.close();
  }
});

test('CLAIM with no open case → creates ONE pending_tc case with the verified phase tree', async () => {
  const app = await bootTcApp();
  try {
    const opp = seedOpp(app.db);
    const r = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${opp.opportunity_id}/claim?office=roland`, { phases: PHASES });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.attached, false);
    const cases = app.db.table('tc_cases');
    assert.equal(cases.length, 1);
    const kase = cases[0];
    assert.equal(kase.case_id, r.body.caseId);
    assert.equal(kase.status, 'pending_tc');
    assert.equal(kase.od_patient_id, 12827);
    assert.equal(kase.office_id, 'roland');
    assert.equal(kase.urgency, 'high', 'most urgent item, as inferred on the client');
    assert.equal(kase.case_value_cents, 230050);
    assert.equal(kase.assigned_tc, 'tc@carein.ai');
    assert.equal(kase.referral_source, 'existing_patient');
    assert.equal(app.db.table('tc_case_items').length, 2);
    assert.deepEqual(app.db.table('tc_case_items').map((i) => i.od_proc_num).sort(), [501, 502]);
    assert.equal(opp.status, 'claimed');
    assert.equal(opp.claimed_case_id, kase.case_id);
    assert.equal(r.body.opportunity.status, 'claimed');
    const audit = auditRows(app.db);
    assert.ok(audit.some((a) => a.resource_type === 'tc_opportunity' && a.action === 'UPDATE'));
    assert.ok(audit.some((a) => a.resource_type === 'tc_case' && a.action === 'CREATE'));
    for (const a of audit) assert.ok(['READ', 'CREATE', 'UPDATE', 'DELETE'].includes(a.action));
  } finally {
    await app.close();
  }
});

test('CLAIM with an OPEN case → attaches (event only), marks existing_case, never a second case', async () => {
  for (const status of OPEN_CASE_STATUSES) {
    const app = await bootTcApp();
    try {
      const kase = seedCase(app.db, { status });
      const opp = seedOpp(app.db);
      const r = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${opp.opportunity_id}/claim?office=roland`, { phases: PHASES });
      assert.equal(r.status, 200, `${status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.attached, true, status);
      assert.equal(r.body.caseId, kase.case_id);
      assert.equal(app.db.table('tc_cases').length, 1, `${status}: no duplicate case`);
      assert.equal(app.db.table('tc_case_items').length, 0, 'a live case is never overwritten from a snapshot');
      const ev = app.db.table('tc_case_events');
      assert.equal(ev.length, 1);
      assert.equal(ev[0].type, 'note_added');
      assert.equal(ev[0].case_id, kase.case_id);
      assert.equal(opp.status, 'existing_case');
      assert.equal(opp.claimed_case_id, kase.case_id);
      assert.ok(auditRows(app.db).some((a) => a.resource_type === 'tc_case' && a.action === 'UPDATE'));
    } finally {
      await app.close();
    }
  }
});

test('CLAIM when every existing case is TERMINAL → a NEW case (the partition, reused)', async () => {
  for (const status of TERMINAL_CASE_STATUSES) {
    const app = await bootTcApp();
    try {
      seedCase(app.db, { status });
      const opp = seedOpp(app.db);
      const r = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${opp.opportunity_id}/claim?office=roland`, {});
      assert.equal(r.status, 200, status);
      assert.equal(r.body.attached, false, status);
      assert.equal(app.db.table('tc_cases').length, 2);
    } finally {
      await app.close();
    }
  }
});

test('CLAIM: an open case in the OTHER office is a different patient — does not attach', async () => {
  const app = await bootTcApp();
  try {
    seedCase(app.db, { office_id: 'valley', od_patient_id: 7115 });
    const opp = seedOpp(app.db, { office_id: 'valley', od_patient_id: 7115, patient_name: 'TestValley, Stedi' });
    seedCase(app.db, { office_id: 'roland', od_patient_id: 7115, status: 'presented' });
    const r = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${opp.opportunity_id}/claim?office=valley`, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.attached, true);
    const target = app.db.table('tc_cases').find((c) => c.case_id === r.body.caseId);
    assert.equal(target.office_id, 'valley');
    // And a roland request cannot reach the valley row at all.
    const cross = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${opp.opportunity_id}/dismiss?office=roland`, { reason: 'x' });
    assert.equal(cross.status, 404);
  } finally {
    await app.close();
  }
});

test('CLAIM twice → 409 ALREADY_CLAIMED with the case, and still one case', async () => {
  const app = await bootTcApp();
  try {
    const opp = seedOpp(app.db);
    const first = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${opp.opportunity_id}/claim?office=roland`, {});
    const again = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${opp.opportunity_id}/claim?office=roland`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'ALREADY_CLAIMED');
    assert.equal(again.body.caseId, first.body.caseId);
    assert.equal(app.db.table('tc_cases').length, 1);
  } finally {
    await app.close();
  }
});

test('CLAIM refuses a phase tree that prices or invents treatment the snapshot does not hold', async () => {
  const app = await bootTcApp();
  try {
    const opp = seedOpp(app.db);
    const priced = JSON.parse(JSON.stringify(PHASES));
    priced[0].items[0].feeCents = 1;
    let r = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${opp.opportunity_id}/claim?office=roland`, { phases: priced });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'FEE_MISMATCH');
    const invented = JSON.parse(JSON.stringify(PHASES));
    invented[0].items[0].odProcNum = 999;
    r = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${opp.opportunity_id}/claim?office=roland`, { phases: invented });
    assert.equal(r.body.code, 'ITEM_NOT_IN_SNAPSHOT');
    r = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${opp.opportunity_id}/claim?office=roland`, { phases: PHASES, extra: 1 });
    assert.equal(r.status, 400, 'strict body');
    assert.equal(app.db.table('tc_cases').length, 0);
    assert.equal(opp.status, 'new');
  } finally {
    await app.close();
  }
});

test('CLAIM refuses a pending name, a cleared row, and a dismissed row', async () => {
  const app = await bootTcApp();
  try {
    const noName = seedOpp(app.db, { patient_name: null });
    let r = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${noName.opportunity_id}/claim?office=roland`, {});
    assert.equal(r.body.code, 'PATIENT_NAME_PENDING');
    const cleared = seedOpp(app.db, { od_patient_id: 12828, cleared_at: new Date() });
    r = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${cleared.opportunity_id}/claim?office=roland`, {});
    assert.equal(r.body.code, 'NO_LONGER_PLANNED');
    const dismissed = seedOpp(app.db, { od_patient_id: 990003, status: 'dismissed', dismissed_reason: 'No' });
    r = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${dismissed.opportunity_id}/claim?office=roland`, {});
    assert.equal(r.body.code, 'NOT_CLAIMABLE');
    assert.equal(app.db.table('tc_cases').length, 0);
  } finally {
    await app.close();
  }
});

test('DISMISS requires a reason, records who, and is refused on a claimed row', async () => {
  const app = await bootTcApp();
  try {
    const opp = seedOpp(app.db);
    let r = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${opp.opportunity_id}/dismiss?office=roland`, {});
    assert.equal(r.status, 400);
    r = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${opp.opportunity_id}/dismiss?office=roland`, { reason: '   ' });
    assert.equal(r.status, 400, 'whitespace is not a reason');
    r = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${opp.opportunity_id}/dismiss?office=roland`, { reason: 'Patient moved away' });
    assert.equal(r.status, 200);
    assert.equal(opp.status, 'dismissed');
    assert.equal(opp.dismissed_reason, 'Patient moved away');
    assert.equal(opp.dismissed_by, 'tc@carein.ai');
    assert.equal(r.body.opportunity.status, 'dismissed');

    const claimed = seedOpp(app.db, { od_patient_id: 12828, status: 'claimed', claimed_case_id: randomUUID() });
    r = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${claimed.opportunity_id}/dismiss?office=roland`, { reason: 'x' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'NOT_DISMISSABLE');
  } finally {
    await app.close();
  }
});

test('the hygiene role cannot reach the Opportunities inbox (tc.full)', async () => {
  const app = await bootTcApp({ role: 'hygiene' });
  try {
    const r = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland');
    assert.equal(r.status, 403);
  } finally {
    await app.close();
  }
});

test('an unentitled tenant gets MODULE_NOT_ENTITLED', async () => {
  const app = await bootTcApp({ modules: ['voice'] });
  try {
    const r = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'MODULE_NOT_ENTITLED');
  } finally {
    await app.close();
  }
});

test('a pg DATE (parsed as local midnight) reaches the case as the same calendar day', async () => {
  const app = await bootTcApp();
  try {
    const opp = seedOpp(app.db, { planned_date: new Date(2026, 7, 15) });
    const r = await api(app.baseUrl, 'POST', `/api/tc/opportunities/${opp.opportunity_id}/claim?office=roland`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(app.db.table('tc_cases')[0].diagnosed_date, '2026-08-15');
    const list = await api(app.baseUrl, 'GET', '/api/tc/opportunities?office=roland&status=claimed');
    assert.equal(list.body.opportunities[0].plannedDate, '2026-08-15');
  } finally {
    await app.close();
  }
});
