'use strict';

/**
 * The shadow gate, through the assembled mount.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SLICE IS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * Roland goes to production in shadow mode: a real biller works real EOBs end
 * to end — upload, match, confirm, review, approve — while a chart write stays
 * IMPOSSIBLE until a human flips a switch. "Everybody remembers not to press
 * Drain" is not a gate. This file is the proof that the gate is.
 *
 * Two conditions, and both are required for any Open Dental write in the drain:
 *   1. the office is in `postingDrain.OFFICES_ENABLED_FOR_POSTING` (the code
 *      ceiling, D-7 — untouched by this slice);
 *   2. `rcm_office_settings.drain_enabled` is true, read AT DRAIN TIME.
 *
 * The strongest claim below is the first test: with the switch off, the drain
 * route refuses BEFORE ANY OPEN DENTAL CALL — asserted as a call count of ZERO
 * on the fake client, not as an absence of writes. A refusal that still read a
 * practice's definitions would be a refusal that had already touched Open
 * Dental.
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
 * One drainable plan on roland, with the shadow gate in whatever state the test
 * needs. Deliberately a copy of posting.test.js's fixture rather than an import:
 * that file's fixture serves its own claims and is edited for them, and a shared
 * one would make either suite's changes silently reshape the other's.
 */
function seedDrainablePlan(db, { drainEnabled = false } = {}) {
  seedOfficeSettings(db, { roland: drainEnabled, valley: drainEnabled });
  db.seed('rcm_user_map', [
    {
      user_key: 'user-1',
      platform_email: 'billing@carein.ai',
      display_name: 'Billing User',
      active: true,
    },
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

/**
 * An Open Dental client that COUNTS EVERY CALL, reads included.
 *
 * `FakeOd.writesIssued()` answers "did it write"; this answers the stronger
 * question the shadow gate is about: did it TALK to Open Dental at all. A drain
 * that resolved a practice's PayType definitions before refusing has already
 * spent a paced credential slot on a press that was never allowed.
 */
function countingOd() {
  const od = new FakeOd({ claims: [], claimProcs: [] });
  const calls = [];
  const client = od.client;
  const wrap = (name) => {
    const original = client[name];
    if (typeof original !== 'function') return;
    client[name] = (...args) => {
      calls.push(`${name} ${String(args[0])}`);
      return original.apply(client, args);
    };
  };
  for (const name of Object.keys(client)) wrap(name);
  od.callsMade = () => calls;
  return od;
}

const drain = (app, office = 'roland', body = {}) =>
  api(app.baseUrl, 'POST', `/api/rcm/posting/drain?office=${office}`, {
    body: JSON.stringify(body),
    json: true,
  });

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE SWITCH IS OFF
// ═══════════════════════════════════════════════════════════════════════════

test('switched off: the drain refuses BEFORE any Open Dental call', async () => {
  const db = seedDrainablePlan(new FakeRcmDb(), { drainEnabled: false });
  const od = countingOd();
  const app = await bootRcmApp({ db, od });
  try {
    const res = await drain(app);

    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'DRAIN_DISABLED_FOR_OFFICE');
    assert.equal(res.body.blocked, postingGate.DRAIN_DISABLED);
    assert.equal(res.body.blocked, 'drain_disabled_for_office');
    assert.equal(res.body.office, 'roland');

    /*
     * ZERO. Not "no writes" — no calls at all. This is the claim the whole
     * slice rests on: while the switch is off, Open Dental is not spoken to.
     */
    assert.deepEqual(od.callsMade(), [], 'the practice was never contacted');
    assert.deepEqual(od.writesIssued(), []);
  } finally {
    await app.close();
  }
});

test('switched off: the plans are untouched — still approved, never blocked', async () => {
  /*
   * THE DIFFERENCE FROM D-7. A valley plan is marked `blocked` per row, because
   * "this practice has never been validated" is a fact about that plan that a
   * biller must see on it. Shadow mode is a switch somebody will flip this
   * week; blocking twenty approved plans on the way would make her re-press
   * every one afterwards to clear a state that was never about them.
   */
  const db = seedDrainablePlan(new FakeRcmDb(), { drainEnabled: false });
  const app = await bootRcmApp({ db, od: countingOd() });
  try {
    await drain(app);

    const row = db.table('rcm_posting_queue')[0];
    assert.equal(row.status, 'approved', 'the plan is exactly where the biller left it');
    assert.equal(row.blocked_reason, null, "the refusal is the route's, not the plan's");
    assert.equal(row.drain_step, null);
    assert.equal(row.attempt_count, 0, 'nothing was attempted, so nothing was counted');
    assert.equal(row.drained_by, null);
    assert.equal(row.drain_attempt_at, null);
    assert.equal(row.last_error, null);
    assert.equal(db.table('rcm_posting_queue_line')[0].status, 'pending');
  } finally {
    await app.close();
  }
});

test('switched off: `drain_disabled_for_office` is NOT a block reason', async () => {
  // It cannot be. `blocked_reason` carries no CHECK, so nothing in the database
  // would have stopped it being written there — this is the assertion that the
  // vocabularies stay disjoint, and it is what `rcm-labels.test.ts` leans on.
  assert.ok(
    !Object.values(postingDrain.BLOCK_REASONS).includes(postingGate.DRAIN_DISABLED),
    'the shadow refusal must never join the per-plan blocked vocabulary'
  );
});

test('switched off: the refusal is audited ONCE PER PRESS, not once per plan', async () => {
  const db = seedDrainablePlan(new FakeRcmDb(), { drainEnabled: false });
  // A second plan waiting, so "per plan" and "per press" give different answers.
  db.seed('rcm_posting_queue', [
    {
      ...db.table('rcm_posting_queue')[0],
      queue_id: '22222222-2222-4333-8444-555555555555',
      remittance_key: 'roland:830200002',
    },
  ]);
  const app = await bootRcmApp({ db, od: countingOd() });
  try {
    await drain(app);
    const rows = auditRows(db).filter((r) => r.resource_type === 'rcm_posting_drain');
    assert.equal(rows.length, 1, `one row per press, got ${rows.length}`);
    assert.equal(rows[0].result, 'ERROR', 'a refusal, not a run');
    assert.equal(rows[0].office, 'roland');
    assert.equal(rows[0].resource_id, null, 'no plan was acted on');

    await drain(app);
    assert.equal(
      auditRows(db).filter((r) => r.resource_type === 'rcm_posting_drain').length,
      2,
      'and a second press leaves a second row — presses are what happened'
    );
  } finally {
    await app.close();
  }
});

test('switched off: no crosswalk row is minted for a press that was refused', async () => {
  /*
   * The gate runs BEFORE `resolveRcmActor`. A refused press should leave nothing
   * behind but its audit line — not a `rcm_user_map` row for somebody who never
   * did anything.
   */
  const db = seedDrainablePlan(new FakeRcmDb(), { drainEnabled: false });
  db.table('rcm_user_map').length = 0;
  const app = await bootRcmApp({ db, od: countingOd() });
  try {
    await drain(app);
    assert.deepEqual(db.table('rcm_user_map'), []);
  } finally {
    await app.close();
  }
});

test('a MISSING settings row refuses exactly like an off one', async () => {
  // Fail closed. The migration seeds both offices, so this is a database
  // migrations have not reached — and that is not a licence to post.
  postingGate._resetForTests();
  const db = seedDrainablePlan(new FakeRcmDb(), { drainEnabled: true });
  db.tables.delete('rcm_office_settings');
  const od = countingOd();
  const app = await bootRcmApp({ db, od });
  try {
    const res = await drain(app);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'DRAIN_DISABLED_FOR_OFFICE');
    assert.deepEqual(od.callsMade(), []);
    assert.equal(db.table('rcm_posting_queue')[0].status, 'approved');
  } finally {
    await app.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE SWITCH IS ON
// ═══════════════════════════════════════════════════════════════════════════

test('switched on, and the office is in the ceiling: the drain proceeds', async () => {
  const db = seedDrainablePlan(new FakeRcmDb(), { drainEnabled: true });
  const app = await bootRcmApp({ db, od: countingOd() });
  try {
    const res = await drain(app);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.drainEnabled, undefined, 'the drain answers with outcomes, not settings');
    assert.equal(res.body.ran, 1, JSON.stringify(res.body.outcomes));
    assert.notEqual(db.table('rcm_posting_queue')[0].status, 'approved', 'the plan moved');
  } finally {
    await app.close();
  }
});

test('the switch cannot open an office the CODE ceiling refuses', async () => {
  /*
   * BOTH conditions, and the toggle is the weaker one. Switching valley on in
   * the database does NOT make valley postable: D-7 is a statement that a
   * practice has been validated, and only a code change with the evidence in
   * the same commit can make it.
   */
  const db = seedDrainablePlan(new FakeRcmDb(), { drainEnabled: true });
  db.table('rcm_posting_queue')[0].office_id = 'valley';
  db.table('rcm_posting_queue_line')[0].office_id = 'valley';
  db.table('rcm_claims')[0].office_id = 'valley';
  const od = countingOd();
  const app = await bootRcmApp({ db, od });
  try {
    const res = await drain(app, 'valley');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.outcomes[0].status, 'blocked');
    assert.equal(res.body.outcomes[0].reason, postingDrain.BLOCK_REASONS.VALLEY_NOT_ENABLED);
    assert.deepEqual(od.callsMade(), [], 'not even a read of Riley’s definitions');
  } finally {
    await app.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. READ AT DRAIN TIME — NOT CACHED
// ═══════════════════════════════════════════════════════════════════════════

test('the switch is read on EVERY press — a flip between two presses takes effect', async () => {
  /*
   * The one behaviour a cache would break, and the reason this value is not
   * cached the way `odOfficeConfig` caches DefNums for an hour. An admin flips
   * this switch precisely so the NEXT press behaves differently; an answer up to
   * an hour old would mean the flip silently did not take.
   *
   * Both directions, in one test, against one running app — so it cannot pass by
   * the settings having been read once at boot.
   */
  const db = seedDrainablePlan(new FakeRcmDb(), { drainEnabled: false });
  const app = await bootRcmApp({ db, od: countingOd() });
  try {
    const first = await drain(app);
    assert.equal(first.status, 409, 'off: refused');

    db.table('rcm_office_settings').find((r) => r.office_id === 'roland').drain_enabled = true;

    const second = await drain(app);
    assert.equal(second.status, 200, `on: ran — ${JSON.stringify(second.body)}`);
    assert.equal(second.body.ran, 1);

    db.table('rcm_office_settings').find((r) => r.office_id === 'roland').drain_enabled = false;

    const third = await drain(app);
    assert.equal(third.status, 409, 'off again: refused again, same press');
    assert.equal(third.body.code, 'DRAIN_DISABLED_FOR_OFFICE');
  } finally {
    await app.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. WHAT THE SCREEN IS TOLD
// ═══════════════════════════════════════════════════════════════════════════

test('the queue reports the switch on its OWN axis, beside the ceiling', async () => {
  /*
   * Two facts with two remedies. `postingEnabled: false` means the practice has
   * never been validated and the fix is a code change; `drainEnabled: false`
   * means an admin has not switched it on and the fix is one toggle. A screen
   * that showed one sentence for both would send a biller to the wrong person.
   */
  const db = seedDrainablePlan(new FakeRcmDb(), { drainEnabled: false });
  const app = await bootRcmApp({ db, od: countingOd() });
  try {
    const list = await api(app.baseUrl, 'GET', '/api/rcm/posting/queue?office=roland');
    assert.equal(list.status, 200);
    assert.equal(list.body.drainEnabled, false, 'shadow mode');
    assert.equal(list.body.postingEnabled, true, 'and roland IS validated — different fact');

    const detail = await api(
      app.baseUrl,
      'GET',
      `/api/rcm/posting/queue/${QUEUE_ID}?office=roland`
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.drainEnabled, false);
    assert.equal(detail.body.postingEnabled, true);
  } finally {
    await app.close();
  }
});

test('a reviewer sees the shadow state too — reading it is not a posting act', async () => {
  const db = seedDrainablePlan(new FakeRcmDb(), { drainEnabled: false });
  const app = await bootRcmApp({ db, od: countingOd(), role: 'reviewer' });
  try {
    const list = await api(app.baseUrl, 'GET', '/api/rcm/posting/queue?office=roland');
    assert.equal(list.status, 200);
    assert.equal(list.body.drainEnabled, false);
    assert.equal(list.body.canDrain, false, 'and she still cannot press it');
  } finally {
    await app.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE DOCUMENT RETRY IS AN OPEN DENTAL WRITE TOO
// ═══════════════════════════════════════════════════════════════════════════

test('switched off: the EOB document retry refuses as well', async () => {
  /*
   * "No Open Dental write while posting is switched off" is a claim about the
   * CHART, not about money. `POST /queue/:id/attach-document` files a PDF into
   * a patient's images, so a plan that posted before the switch was turned off
   * cannot file its EOB afterwards either.
   */
  const db = seedDrainablePlan(new FakeRcmDb(), { drainEnabled: false });
  db.table('rcm_posting_queue')[0].status = 'posted';
  const od = countingOd();
  const app = await bootRcmApp({ db, od });
  try {
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/posting/queue/${QUEUE_ID}/attach-document?office=roland`,
      { body: JSON.stringify({}), json: true }
    );
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'DRAIN_DISABLED_FOR_OFFICE');
    assert.equal(res.body.blocked, postingGate.DRAIN_DISABLED);
    assert.deepEqual(od.callsMade(), []);
  } finally {
    await app.close();
  }
});
