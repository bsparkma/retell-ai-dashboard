'use strict';

/**
 * /api/tc/followups — the unified outreach queue: create/complete/skip/
 * reschedule, SSO completion identity, the /due queue query, office scoping.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const MINIMAL_CASE = {
  patientName: 'Queue Patient',
  category: 'quadrant',
  status: 'presented',
  urgency: 'medium',
};

async function createCase(baseUrl, office = 'roland') {
  const res = await api(baseUrl, 'POST', `/api/tc/cases?office=${office}`, MINIMAL_CASE);
  assert.equal(res.status, 201);
  return res.body.case.caseId;
}

test('create → complete round-trip stamps SSO identity and writes the case event', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const caseId = await createCase(baseUrl);

    const created = await api(baseUrl, 'POST', '/api/tc/followups?office=roland', {
      caseId,
      kind: 'followup',
      dueDate: '2026-08-05',
      channel: 'phone_call',
      talkingPoint: 'Check on financing decision',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const f = created.body.followup;
    assert.equal(f.status, 'pending');
    assert.equal(f.source, 'manual');

    const completed = await api(baseUrl, 'POST', `/api/tc/followups/${f.followup_id}/complete?office=roland`, {
      outcomeNote: 'Spoke with patient, scheduling next week',
      patientResponded: true,
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.followup.status, 'completed');
    assert.equal(completed.body.followup.completed_by, 'tc@carein.ai');
    assert.ok(completed.body.followup.completed_at);

    const events = db.table('tc_case_events').filter((e) => e.type === 'follow_up_completed');
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, 'tc@carein.ai');

    // Completing again → 404 (no longer pending; no double completion).
    const again = await api(baseUrl, 'POST', `/api/tc/followups/${f.followup_id}/complete?office=roland`, {});
    assert.equal(again.status, 404);

    assert.ok(auditRows(db).some((r) => r.action === 'CREATE' && r.resource_type === 'tc_followup'));
    assert.ok(auditRows(db).some((r) => r.action === 'UPDATE' && r.resource_type === 'tc_followup'));
  } finally {
    await close();
  }
});

test('contract rejection: bad channel / nurtureType on a plain followup → 400', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    const caseId = await createCase(baseUrl);

    const badChannel = await api(baseUrl, 'POST', '/api/tc/followups?office=roland', {
      caseId,
      kind: 'followup',
      dueDate: '2026-08-05',
      channel: 'carrier_pigeon',
      talkingPoint: 'x',
    });
    assert.equal(badChannel.status, 400);

    const nurtureTypeOnFollowup = await api(baseUrl, 'POST', '/api/tc/followups?office=roland', {
      caseId,
      kind: 'followup',
      dueDate: '2026-08-05',
      channel: 'text',
      talkingPoint: 'x',
      nurtureType: 'seasonal',
    });
    assert.equal(nurtureTypeOnFollowup.status, 400);

    // source 'legacy' is importer-only.
    const legacySource = await api(baseUrl, 'POST', '/api/tc/followups?office=roland', {
      caseId,
      kind: 'followup',
      dueDate: '2026-08-05',
      channel: 'text',
      talkingPoint: 'x',
      source: 'legacy',
    });
    assert.equal(legacySource.status, 400);
  } finally {
    await close();
  }
});

test('reschedule moves pending items only; skip closes without a case event', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    const caseId = await createCase(baseUrl);
    const created = await api(baseUrl, 'POST', '/api/tc/followups?office=roland', {
      caseId,
      kind: 'nurture',
      dueDate: '2026-08-10',
      channel: 'email',
      talkingPoint: 'Season check-in',
      nurtureType: 'seasonal',
      source: 'auto',
    });
    const id = created.body.followup.followup_id;

    const moved = await api(baseUrl, 'POST', `/api/tc/followups/${id}/reschedule?office=roland`, {
      dueDate: '2026-09-01',
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.followup.due_date, '2026-09-01');

    const skipped = await api(baseUrl, 'POST', `/api/tc/followups/${id}/skip?office=roland`, {});
    assert.equal(skipped.status, 200);
    assert.equal(skipped.body.followup.status, 'skipped');
    assert.equal(db.table('tc_case_events').filter((e) => e.type === 'follow_up_completed').length, 0);

    const rescheduleClosed = await api(baseUrl, 'POST', `/api/tc/followups/${id}/reschedule?office=roland`, {
      dueDate: '2026-09-15',
    });
    assert.equal(rescheduleClosed.status, 404, 'skipped items cannot be rescheduled');
  } finally {
    await close();
  }
});

test('office scoping: a roland followup is untouchable from a valley context', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    const caseId = await createCase(baseUrl);
    const created = await api(baseUrl, 'POST', '/api/tc/followups?office=roland', {
      caseId,
      kind: 'followup',
      dueDate: '2026-08-05',
      channel: 'text',
      talkingPoint: 'x',
    });
    const id = created.body.followup.followup_id;

    const cross = await api(baseUrl, 'POST', `/api/tc/followups/${id}/complete?office=valley`, {});
    assert.equal(cross.status, 404);

    const list = await api(baseUrl, 'GET', '/api/tc/followups?office=valley');
    assert.equal(list.body.followups.length, 0);
  } finally {
    await close();
  }
});

test('GET /due runs ONE office-scoped queue query (joined to tc_cases)', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    // The /due query joins tc_followups → tc_cases; the fake store answers it
    // with a hand-joined result so the route's mapping is still exercised.
    db.onQuery(/SELECT f\.followup_id.+JOIN tc_cases c/i, (text, params) => {
      assert.equal(params[0], 'roland', 'first param must be the office');
      const cases = new Map(db.table('tc_cases').map((c) => [c.case_id, c]));
      const rows = db
        .table('tc_followups')
        .filter((f) => f.office_id === params[0] && f.status === 'pending' && String(f.due_date) <= String(params[1]))
        .map((f) => {
          const c = cases.get(f.case_id);
          return {
            ...f,
            patient_name: c.patient_name,
            case_phone: c.phone,
            case_status: c.status,
            assigned_tc: c.assigned_tc,
            case_value_cents: c.case_value_cents,
            case_urgency: c.urgency,
          };
        });
      return { rows };
    });

    const caseId = await createCase(baseUrl);
    await api(baseUrl, 'POST', '/api/tc/followups?office=roland', {
      caseId,
      kind: 'followup',
      dueDate: '2026-01-01', // overdue
      channel: 'phone_call',
      talkingPoint: 'overdue item',
    });
    await api(baseUrl, 'POST', '/api/tc/followups?office=roland', {
      caseId,
      kind: 'followup',
      dueDate: '2099-01-01', // far future — not due
      channel: 'phone_call',
      talkingPoint: 'future item',
    });

    const due = await api(baseUrl, 'GET', '/api/tc/followups/due?office=roland');
    assert.equal(due.status, 200, JSON.stringify(due.body));
    assert.equal(due.body.due.length, 1, 'only the overdue item is due');
    assert.equal(due.body.due[0].talking_point, 'overdue item');
    assert.equal(due.body.due[0].patient_name, 'Queue Patient');
  } finally {
    await close();
  }
});
