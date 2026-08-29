'use strict';

/**
 * RCM Slice 6c — /api/rcm/posting, through the assembled mount.
 *
 * Booted through `routes/rcm/index.js` rather than by calling handlers, because
 * the thing most worth testing here is the MOUNT: `POST /posting/drain` is
 * gated by NOT being in QUEUE_PATHS, and a test that reached the handler
 * directly would pass with that omission reversed.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FakeRcmDb,
  FakeOd,
  bootRcmApp,
  api,
  auditRows,
  seedOfficeSettings,
} = require('./rcmTestUtils');
const postingGate = require('../../services/rcm/postingGate');
const postingDrain = require('../../services/rcm/postingDrain');

const QUEUE_ID = '11111111-2222-4333-8444-555555555555';
const LINE_ID = '66666666-7777-4888-8999-000000000000';
const BATCH_ID = '8acb0e32-35ae-5cd8-9692-7b5e318a31c2';
const CLAIM_ID = 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d';

/**
 * A plan sitting at `approved` with one line, plus the rows that label it.
 *
 * THE SHADOW GATE IS SEEDED OFF, exactly as the tenant migration seeds it and
 * exactly as production ships. A test that wants the drain to actually run says
 * so: `seedQueue(db, { drainEnabled: true })`. Defaulting it open would let a
 * future drain test pass without the gate ever being consulted.
 */
function seedQueue(db, overrides = {}) {
  seedOfficeSettings(db, { roland: overrides.drainEnabled === true, valley: overrides.drainEnabled === true });
  db.seed('rcm_user_map', [
    { user_key: 'user-1', platform_email: 'billing@carein.ai', display_name: 'Billing User', active: true },
  ]);
  db.seed('rcm_payment_batches', [
    {
      batch_id: BATCH_ID,
      office_id: 'roland',
      payer: 'DELTA DENTAL OF ARKANSAS',
      check_number: '830200001',
      eft_number: null,
      payment_method: 'check',
      deposit_date: '2026-03-01',
      total_amount_cents: 15000,
      status: 'ready',
    },
  ]);
  db.seed('rcm_posting_queue', [
    {
      queue_id: QUEUE_ID,
      office_id: 'roland',
      batch_id: BATCH_ID,
      remittance_key: 'roland:830200001',
      status: 'approved',
      is_recoupment: false,
      carrier_eob_date: '2026-03-01',
      intended_total_cents: 15000,
      posted_total_cents: 0,
      od_claim_payment_num: null,
      approved_by: 'user-1',
      approved_at: new Date('2026-03-02T11:10:00Z'),
      started_at: null,
      finished_at: null,
      attempt_count: 0,
      last_error: null,
      blocked_reason: null,
      drain_step: null,
      drained_by: null,
      drain_attempt_at: null,
      reconciled_at: null,
      ...(overrides.queue || {}),
    },
  ]);
  db.seed('rcm_posting_queue_line', [
    {
      queue_line_id: LINE_ID,
      queue_id: QUEUE_ID,
      office_id: 'roland',
      position: 1,
      od_claim_proc_num: 99001,
      od_claim_num: 53648,
      claim_id: CLAIM_ID,
      batch_claim_payment_id: null,
      intended_ins_pay_amt_cents: 15000,
      intended_write_off_cents: 6000,
      intended_ded_applied_cents: 0,
      is_supplemental: false,
      status: 'pending',
      claimproc_written_at: null,
      claim_received_at: null,
      paid_at: null,
      od_claim_payment_num: null,
      last_error: null,
      readback: null,
      readback_at: null,
      skip_reason: null,
      ...(overrides.line || {}),
    },
  ]);
  db.seed('rcm_claims', [
    {
      claim_id: CLAIM_ID,
      office_id: 'roland',
      claim_number: '53648',
      patient_name: 'Test 2, Stedi',
      od_claim_num: 53648,
      od_match_status: 'confirmed',
      posting_queue_id: QUEUE_ID,
      od_match_snapshot: { version: 2 },
    },
  ]);
  return db;
}

/** The read-only client every test here uses unless it needs to drain. */
function readOnlyOd() {
  return new FakeOd({ claims: [], claimProcs: [] });
}

// ─── The queue list ──────────────────────────────────────────────────────────

test('GET /posting/queue lists the office plans with the brief\'s vocabulary', async () => {
  const db = seedQueue(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/rcm/posting/queue?office=roland');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.rows.length, 1);

    const row = res.body.rows[0];
    // The STORED word and the SCREEN word both ship, so a client is never forced
    // to reverse the mapping and can never disagree with the server about it.
    assert.equal(row.status, 'approved');
    assert.equal(row.statusLabel, 'queued');
    assert.equal(row.checkNumber, '830200001', 'the plan is labelled by its check');
    assert.equal(row.payer, 'DELTA DENTAL OF ARKANSAS');
    assert.equal(row.intendedTotalCents, 15000);
    assert.equal(row.odClaimPaymentNum, null, 'nothing has landed yet');
    assert.equal(row.reconciledAt, null);
  } finally {
    await app.close();
  }
});

test('the per-state counts are ZERO-FILLED over the whole vocabulary', async () => {
  const db = seedQueue(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/rcm/posting/queue?office=roland');
    // A state this office has no rows in must read as a measured 0, not as a
    // missing key a screen renders as an em dash.
    for (const status of Object.keys(postingDrain.QUEUE_STATUS_LABEL)) {
      assert.equal(typeof res.body.byStatus[status], 'number', `${status} must be counted`);
    }
    assert.equal(res.body.byStatus.approved, 1);
    assert.equal(res.body.byStatus.posted, 0);
    assert.equal(res.body.byStatus.blocked, 0);
    assert.equal(res.body.total, 1);
  } finally {
    await app.close();
  }
});

test("another office's plan is NOT FOUND, not refused", async () => {
  const db = seedQueue(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    const list = await api(app.baseUrl, 'GET', '/api/rcm/posting/queue?office=valley');
    assert.equal(list.status, 200);
    assert.equal(list.body.rows.length, 0, 'office scoping makes it unreachable, not forbidden');

    const detail = await api(app.baseUrl, 'GET', `/api/rcm/posting/queue/${QUEUE_ID}?office=valley`);
    assert.equal(detail.status, 404);
    assert.equal(detail.body.code, 'QUEUE_NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('a malformed plan id is a 404, never a 500 that tells a prober which ids are real', async () => {
  const db = seedQueue(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/rcm/posting/queue/not-a-uuid?office=roland');
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'QUEUE_NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('the office param is required, router-wide, before anything else runs', async () => {
  const db = seedQueue(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    for (const path of ['/api/rcm/posting/queue', `/api/rcm/posting/queue/${QUEUE_ID}`]) {
      const res = await api(app.baseUrl, 'GET', path);
      assert.equal(res.status, 400, path);
      assert.equal(res.body.code, 'INVALID_OFFICE');
    }
    const drain = await api(app.baseUrl, 'POST', '/api/rcm/posting/drain', {
      body: JSON.stringify({}),
      json: true,
    });
    assert.equal(drain.status, 400);
    assert.equal(drain.body.code, 'INVALID_OFFICE');
  } finally {
    await app.close();
  }
});

// ─── The detail ──────────────────────────────────────────────────────────────

test('GET /posting/queue/:id carries the lines, the read-back evidence and the 6d seam', async () => {
  const db = seedQueue(new FakeRcmDb(), {
    queue: {
      status: 'posted',
      od_claim_payment_num: 21253,
      reconciled_at: new Date('2026-03-02T12:00:00Z'),
      posted_total_cents: 15000,
      drain_step: 'document_attach',
    },
    line: {
      status: 'paid',
      od_claim_payment_num: 21253,
      paid_at: new Date('2026-03-02T12:00:00Z'),
      readback: {
        step: 'claimproc_write',
        agreed: true,
        sent: { Status: 'Received', InsPayAmt: 150, WriteOff: 60, DedApplied: 0 },
        read: { Status: 'Received', InsPayAmt: 150, WriteOff: 60, DedApplied: 0 },
        mismatches: [],
      },
      readback_at: new Date('2026-03-02T12:00:00Z'),
    },
  });
  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/posting/queue/${QUEUE_ID}?office=roland`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal(res.body.plan.statusLabel, 'posted');
    assert.equal(res.body.plan.odClaimPaymentNum, 21253, 'the proof the money landed');
    assert.ok(res.body.plan.reconciledAt, 'and the proof it was read back');

    assert.equal(res.body.lines.length, 1);
    assert.equal(res.body.lines[0].status, 'paid');
    assert.equal(res.body.lines[0].readback.agreed, true, 'the evidence is kept, not just a verdict');

    /*
     * 6d FILLED THE SEAM. It no longer says "not yet" — it says what actually
     * happened to the EOB, on its own axis.
     *
     * `status: null` is NOT ATTEMPTED, and it is a real third state: this plan
     * is `posted` with nothing filed, which is exactly what a remittance that
     * arrived as raw 835 looks like. A screen must render that as "nothing to
     * file", never as a failure with a retry button behind it.
     */
    assert.equal(res.body.documentAttach.implemented, true);
    assert.equal(res.body.documentAttach.status, null);
    assert.equal(res.body.documentAttach.error, null);
    assert.deepEqual(res.body.documentAttach.documents, []);
    assert.equal(res.body.documentAttach.retryRequires, 'rcm.post');
  } finally {
    await app.close();
  }
});

test('reading a plan writes exactly one audit row — it names a patient', async () => {
  const db = seedQueue(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    await api(app.baseUrl, 'GET', `/api/rcm/posting/queue/${QUEUE_ID}?office=roland`);
    const rows = db.table('audit_log').filter((r) => r.resource_type === 'rcm_posting_queue');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'READ');
    assert.equal(rows[0].office, 'roland');
    assert.equal(rows[0].result, 'SUCCESS');
  } finally {
    await app.close();
  }
});

test('the LIST writes no audit row — it names no patient', async () => {
  const db = seedQueue(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    await api(app.baseUrl, 'GET', '/api/rcm/posting/queue?office=roland');
    const rows = db.table('audit_log').filter((r) => r.resource_type === 'rcm_posting_queue');
    assert.equal(
      rows.length,
      0,
      'payer, check number, amounts and states are not PHI — auditing them dilutes the trail'
    );
  } finally {
    await app.close();
  }
});

// ─── Permission (D-9) ────────────────────────────────────────────────────────

test('a reviewer can WATCH the queue and cannot press Drain', async () => {
  const db = seedQueue(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: readOnlyOd(), role: 'reviewer' });
  try {
    const list = await api(app.baseUrl, 'GET', '/api/rcm/posting/queue?office=roland');
    assert.equal(list.status, 200, 'watching a plan post is not a posting act');
    assert.equal(list.body.canDrain, false);
    assert.equal(list.body.drainRequires, 'rcm.post');

    const detail = await api(app.baseUrl, 'GET', `/api/rcm/posting/queue/${QUEUE_ID}?office=roland`);
    assert.equal(detail.status, 200, 'and reading WHY one is blocked is not either');
    assert.equal(detail.body.canDrain, false);

    /*
     * The refusal comes from the MOUNT, not from the handler: `POST
     * /posting/drain` is deliberately absent from QUEUE_PATHS, so
     * requireReadWrite demands `rcm.write` by construction and a reviewer never
     * reaches the handler at all. Same structural guarantee approve has, and the
     * same consequence — the platform's FORBIDDEN rather than a prettier
     * in-handler message.
     *
     * `rcm.write` and not `rcm.post`, and the difference is the point: a
     * reviewer is stopped one tier EARLIER than an `rcm_biller` is. The biller
     * clears the mount and is refused by the route's own narrower gate; the
     * reviewer never gets that far.
     */
    const drain = await api(app.baseUrl, 'POST', '/api/rcm/posting/drain?office=roland', {
      body: JSON.stringify({}),
      json: true,
    });
    assert.equal(drain.status, 403);
    assert.equal(drain.body.action, 'rcm.write');
  } finally {
    await app.close();
  }
});

test('an office or admin tier sees canDrain true', async () => {
  for (const role of ['admin', 'office']) {
    const db = seedQueue(new FakeRcmDb());
    const app = await bootRcmApp({ db, od: readOnlyOd(), role });
    try {
      const res = await api(app.baseUrl, 'GET', '/api/rcm/posting/queue?office=roland');
      assert.equal(res.body.canDrain, true, role);
    } finally {
      await app.close();
    }
  }
});

test('a role with no rcm permission at all is refused the whole posting surface', async () => {
  const db = seedQueue(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: readOnlyOd(), role: 'hygiene' });
  try {
    for (const path of ['/api/rcm/posting/queue?office=roland', `/api/rcm/posting/queue/${QUEUE_ID}?office=roland`]) {
      const res = await api(app.baseUrl, 'GET', path);
      assert.equal(res.status, 403, path);
    }
  } finally {
    await app.close();
  }
});

test('a tenant without the rcm module gets MODULE_NOT_ENTITLED, drain included', async () => {
  const db = seedQueue(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: readOnlyOd(), modules: ['voice'] });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/rcm/posting/queue?office=roland');
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
  } finally {
    await app.close();
  }
});

// ─── D-7 ─────────────────────────────────────────────────────────────────────

test('the server states whether posting is enabled for the office — the client never guesses', async () => {
  const db = seedQueue(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    const roland = await api(app.baseUrl, 'GET', '/api/rcm/posting/queue?office=roland');
    assert.equal(roland.body.postingEnabled, true);

    const valley = await api(app.baseUrl, 'GET', '/api/rcm/posting/queue?office=valley');
    assert.equal(
      valley.body.postingEnabled,
      false,
      'a screen that hardcoded "valley is off" would go stale the day it is switched on'
    );
  } finally {
    await app.close();
  }
});

// ─── The drain itself ────────────────────────────────────────────────────────

test('a second concurrent drain is a 409, not a second run', async () => {
  const db = seedQueue(new FakeRcmDb(), { drainEnabled: true });
  const app = await bootRcmApp({ db, od: readOnlyOd() });
  postingDrain.DRAIN_MUTEX.running = true;
  try {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/posting/drain?office=roland', {
      body: JSON.stringify({}),
      json: true,
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'DRAIN_ALREADY_RUNNING');
  } finally {
    postingDrain.DRAIN_MUTEX.running = false;
    await app.close();
  }
});

test('a valley drain blocks the plan and never resolves a client', async () => {
  const db = seedQueue(new FakeRcmDb(), { drainEnabled: true });
  // Re-stamp the plan as valley.
  for (const table of ['rcm_posting_queue', 'rcm_posting_queue_line', 'rcm_claims', 'rcm_payment_batches']) {
    for (const row of db.table(table)) row.office_id = 'valley';
  }
  const od = readOnlyOd();
  const app = await bootRcmApp({ db, od });
  try {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/posting/drain?office=valley', {
      body: JSON.stringify({}),
      json: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.outcomes[0].status, 'blocked');
    assert.equal(res.body.outcomes[0].reason, 'valley_not_enabled');
    assert.equal(res.body.postingEnabled, false);
    assert.deepEqual(od.methodsUsed(), [], 'not one Open Dental call was made');

    const row = db.table('rcm_posting_queue')[0];
    assert.equal(row.status, 'blocked');
    assert.equal(row.blocked_reason, 'valley_not_enabled');
    // Honest, not silent: the row SAYS why, so the queue screen can explain it.
    assert.match(row.last_error, /not enabled for 'valley'/);
  } finally {
    await app.close();
  }
});

test('a malformed queueId narrows to NOTHING rather than draining the whole office', async () => {
  /*
   * `onlyQueueId` is an optional narrowing, and the sentinel for "no narrowing"
   * is null. Passing junk straight through would turn `{queueId: "../.."}` into
   * "drain everything", which is the opposite of what the caller asked for.
   */
  const db = seedQueue(new FakeRcmDb(), { drainEnabled: true });
  const od = readOnlyOd();
  const app = await bootRcmApp({ db, od });
  try {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/posting/drain?office=roland', {
      body: JSON.stringify({ queueId: '../../etc/passwd' }),
      json: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ran, 0);
    assert.deepEqual(od.methodsUsed(), []);
    assert.equal(db.table('rcm_posting_queue')[0].status, 'approved', 'untouched');
  } finally {
    await app.close();
  }
});

test('the drain run is audited as its own CREATE, on top of the per-call rows', async () => {
  const db = seedQueue(new FakeRcmDb(), { drainEnabled: true });
  // No drainable rows, so the run is a clean no-op and the only audit row is the
  // run itself — which is what makes this assertion about the run and not about
  // the calls.
  db.table('rcm_posting_queue')[0].status = 'posted';
  db.table('rcm_posting_queue')[0].od_claim_payment_num = 21253;
  db.table('rcm_posting_queue')[0].reconciled_at = new Date();

  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    await api(app.baseUrl, 'POST', '/api/rcm/posting/drain?office=roland', {
      body: JSON.stringify({}),
      json: true,
    });
    const rows = db.table('audit_log').filter((r) => r.resource_type === 'rcm_posting_drain');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'CREATE');
    assert.equal(rows[0].office, 'roland');
  } finally {
    await app.close();
  }
});

// ─── When the drain hits a defect, the operator is told what it was ──────────

/**
 * The banner the first staging walk showed a biller was the word
 * "Internal error". The drain had hit
 * `column "od_patient_office" does not exist` — the one sentence that named the
 * bug — and `h()` discarded it one layer above the code that had it.
 *
 * The same text is already written into `last_error` and rendered on the queue
 * screen to this same person, so returning it here is not a new audience for
 * anything; it is the same fact, an hour earlier.
 */
test('a drain defect returns its real message, not "Internal error"', async () => {
  const db = seedQueue(new FakeRcmDb(), { drainEnabled: true });
  const DB_ERROR = 'column "od_patient_office" does not exist';
  const realQuery = db.query.bind(db);
  db.query = (text, params) => {
    if (String(text).includes('FROM rcm_claims')) return Promise.reject(new Error(DB_ERROR));
    return realQuery(text, params);
  };

  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    const res = await api(app.baseUrl, 'POST', '/api/rcm/posting/drain?office=roland', {
      body: JSON.stringify({}),
      json: true,
    });

    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'DRAIN_FAILED');
    assert.equal(res.body.error, DB_ERROR, 'the words Postgres used, reaching the person');
    assert.notEqual(res.body.error, 'Internal error');
  } finally {
    await app.close();
  }
});

test('and the plan it was draining is back to approved, pressable again', async () => {
  /*
   * The two halves of the same defect. Surfacing the message without releasing
   * the row would still have left a plan wedged at `posting` with nothing behind
   * it; releasing it without the message would leave a biller with a plan that
   * silently reappeared and no idea why.
   */
  const db = seedQueue(new FakeRcmDb(), { drainEnabled: true });
  const realQuery = db.query.bind(db);
  db.query = (text, params) => {
    if (String(text).includes('FROM rcm_claims')) {
      return Promise.reject(new Error('column "od_patient_office" does not exist'));
    }
    return realQuery(text, params);
  };

  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    await api(app.baseUrl, 'POST', '/api/rcm/posting/drain?office=roland', {
      body: JSON.stringify({}),
      json: true,
    });

    const row = db.table('rcm_posting_queue')[0];
    assert.equal(row.status, 'approved');
    assert.equal(row.drain_step, null);
    assert.match(row.last_error, /od_patient_office/);
  } finally {
    await app.close();
  }
});

// ─── POST /queue/:id/withdraw ────────────────────────────────────────────────

/**
 * Retiring a plan is the only thing in this module that takes money off the
 * board without posting it. It writes nothing to a chart, which is exactly why
 * the guards have to be in the route rather than in the Open Dental layer:
 * there is no read-back to catch a mistake here.
 */

function queueRow(db) {
  return db.table('rcm_posting_queue')[0];
}

test('a withdrawal needs a note, and refuses without one', async () => {
  /*
   * For a `manual` withdrawal the note is the ONLY record of why money that was
   * approved is not going to post. A plan with no account of itself would be the
   * queue quietly losing money nobody can later explain, so this is a 400 rather
   * than an optional field.
   */
  const db = seedQueue(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    for (const body of [{}, { note: '' }, { note: '  ' }, { note: 'no' }]) {
      const res = await api(
        app.baseUrl,
        'POST',
        `/api/rcm/posting/queue/${queueRow(db).queue_id}/withdraw?office=roland`,
        { body: JSON.stringify(body), json: true }
      );
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'WITHDRAW_NOTE_REQUIRED');
    }
    assert.equal(queueRow(db).status, 'approved', 'and nothing moved');
  } finally {
    await app.close();
  }
});

test('a withdrawal with a note retires the plan and records who and why', async () => {
  const db = seedQueue(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/posting/queue/${queueRow(db).queue_id}/withdraw?office=roland`,
      {
        body: JSON.stringify({ note: 'Posted by hand in the desktop before this queue existed.' }),
        json: true,
      }
    );

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'withdrawn');
    assert.equal(res.body.withdrawnReason, 'manual');

    const row = queueRow(db);
    assert.equal(row.status, 'withdrawn');
    assert.equal(row.withdrawn_reason, 'manual');
    assert.match(row.withdrawn_note, /Posted by hand/);
    assert.ok(row.withdrawn_by, 'D-5: a crosswalk key, because Open Dental cannot attribute');
    assert.ok(row.withdrawn_at);
  } finally {
    await app.close();
  }
});

test('a withdrawn plan is not offered for draining', async () => {
  const db = seedQueue(new FakeRcmDb(), { drainEnabled: true });
  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    await api(
      app.baseUrl,
      'POST',
      `/api/rcm/posting/queue/${queueRow(db).queue_id}/withdraw?office=roland`,
      { body: JSON.stringify({ note: 'retiring this one' }), json: true }
    );

    const drain = await api(app.baseUrl, 'POST', '/api/rcm/posting/drain?office=roland', {
      body: JSON.stringify({}),
      json: true,
    });
    assert.equal(drain.status, 200, JSON.stringify(drain.body));
    assert.equal(drain.body.ran, 0, 'the scan does not pick it up at all');
    assert.equal(queueRow(db).status, 'withdrawn', 'and it stayed withdrawn');
  } finally {
    await app.close();
  }
});

test('a plan that already put money in a chart cannot be retired', async () => {
  /*
   * The refusal that matters. Retiring a posted plan would be a way to make the
   * queue disagree with Open Dental — the queue would show nothing owing while
   * the chart carries a payment.
   */
  const db = seedQueue(new FakeRcmDb());
  queueRow(db).status = 'posted';
  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/posting/queue/${queueRow(db).queue_id}/withdraw?office=roland`,
      { body: JSON.stringify({ note: 'trying to hide this' }), json: true }
    );

    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'WITHDRAW_NOT_ALLOWED');
    assert.equal(res.body.status, 'posted');
    assert.match(res.body.error, /already put money in the chart/);
    assert.equal(queueRow(db).status, 'posted');
  } finally {
    await app.close();
  }
});

test('the queue read carries the withdrawal, so a screen can account for it', async () => {
  const db = seedQueue(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    await api(
      app.baseUrl,
      'POST',
      `/api/rcm/posting/queue/${queueRow(db).queue_id}/withdraw?office=roland`,
      { body: JSON.stringify({ note: 'the claim was voided upstream' }), json: true }
    );

    const page = await api(app.baseUrl, 'GET', '/api/rcm/posting/queue?office=roland');
    const row = page.body.rows.find((r) => r.status === 'withdrawn');
    assert.ok(row, 'the plan is still listed — withdrawing is not a delete');
    assert.equal(row.withdrawnReason, 'manual');
    assert.equal(row.withdrawnNote, 'the claim was voided upstream');
    assert.ok(row.withdrawnAt);
    assert.equal(row.statusLabel, 'withdrawn');
  } finally {
    await app.close();
  }
});

test('a plan from another office is a 404, not a refusal', async () => {
  const db = seedQueue(new FakeRcmDb());
  const app = await bootRcmApp({ db, od: readOnlyOd() });
  try {
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/posting/queue/${queueRow(db).queue_id}/withdraw?office=valley`,
      { body: JSON.stringify({ note: 'reaching across offices' }), json: true }
    );
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'QUEUE_NOT_FOUND');
    assert.equal(queueRow(db).status, 'approved');
  } finally {
    await app.close();
  }
});
