'use strict';

/**
 * DID THE APP GET THIS CHECK RIGHT? — the shadow-mode comparison (Stage C-2).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS AT STAKE
 * ═════════════════════════════════════════════════════════════════════════════
 * This record is what the decision to switch posting on gets made from. Two
 * things could make it worthless, and they pull in opposite directions:
 *
 *   IT COULD BE WRONG.       An answer that is silently overwritten, a tally
 *                            that counts something other than what it says, a
 *                            `differed` stored without the sentence that
 *                            explains it — any of those turns evidence into a
 *                            number somebody trusts for no reason.
 *
 *   IT COULD DO SOMETHING.   It sits on the screen where money is authorised,
 *                            two panels above the button that posts it. If
 *                            answering a question could change what posts, the
 *                            honest answer would carry a cost — and the whole
 *                            design rests on it carrying none.
 *
 * The second is the reason the last test in this file drives the REAL posting
 * run twice, once with an answer recorded through the real HTTP route and once
 * without, and compares the Open Dental call transcript and the rows it left.
 *
 * Booted through the REAL /api/rcm stack, the way `worklistState.test.js` does
 * it: auth gate → tenantContext → requireModule('rcm') → requireReadWrite → the
 * real router. A test that called a handler directly would pass with
 * `requireOffice` deleted from index.js, and would say nothing about the D-9
 * tier.
 *
 * NO REAL PATIENTS. Every name and number below is synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeRcmDb, FakeOd, bootRcmApp, api, auditRows } = require('./rcmTestUtils');
const postingDrain = require('../../services/rcm/postingDrain');
const odOfficeConfig = require('../../services/rcm/odOfficeConfig');
const odPacer = require('../../services/rcm/odPacer');

const BATCH = '8acb0e32-35ae-5cd8-9692-7b5e318a31c2';
const BATCH_2 = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';
const CLAIM = 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d';
const QUEUE = 'b4f0e2c1-9a3d-4e58-8f21-7c6d5a4b3e29';
const QUEUE_2 = 'a3e9d1c7-2b48-4f16-9d05-8e7f6a5b4c31';

const Q = '?office=roland';
const json = (body) => ({ body: JSON.stringify(body), json: true });

/**
 * One check with an APPROVED posting on it — the state the question can be
 * asked in. A check with no posting has nothing to compare against and the
 * route says so.
 */
function seed(db, over = {}) {
  const office = over.office || 'roland';
  const batchId = over.batchId || BATCH;
  const queueId = over.queueId || QUEUE;

  db.seed('rcm_payment_batches', [
    {
      batch_id: batchId,
      office_id: office,
      payer: 'SYNTHETIC DENTAL',
      check_number: over.checkNumber || '830200001',
      eft_number: null,
      trace_number: '830200001',
      payment_method: 'check',
      deposit_date: '2026-03-02',
      total_amount_cents: 15000,
      posted_amount_cents: 0,
      plb_total_cents: 0,
      plb_adjustments: [],
      claim_count: 1,
      status: 'ready',
      era_file_key: 'tenant/carein/rcm/era/k1.edi',
      notes: '',
      created_by: null,
      created_at: new Date('2026-03-02T10:00:00Z'),
      parked_at: null,
      parked_by: null,
      parked_note: null,
      set_aside_at: null,
      set_aside_by: null,
      set_aside_reason: null,
      set_aside_reason_note: null,
      /*
       * SEEDED EXPLICITLY, INCLUDING THE NULLS.
       *
       * An omitted column reads back `undefined`, a shape Postgres never
       * produces, and a fixture that hands one out certifies code the real
       * database would fail (RCM_POSTING §15, the FakeRcmDb lesson).
       */
      comparison_verdict: over.comparisonVerdict ?? null,
      comparison_reason: over.comparisonReason ?? null,
      comparison_note: over.comparisonNote ?? null,
      comparison_by: over.comparisonBy ?? null,
      comparison_at: over.comparisonAt ?? null,
      comparison_revision: over.comparisonRevision ?? 0,
    },
  ]);

  if (over.queue !== null) {
    db.seed('rcm_posting_queue', [
      {
        queue_id: queueId,
        office_id: office,
        batch_id: batchId,
        remittance_key: `${office}:${over.checkNumber || '830200001'}`,
        status: over.queueStatus || 'approved',
        approved_by: 'billing@carein.ai',
        approved_at: new Date('2026-03-02T11:00:00Z'),
      },
    ]);
  }
  return db;
}

async function withApp(opts, fn) {
  const app = await bootRcmApp(opts);
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

const answer = (app, body, batchId = BATCH) =>
  api(app.baseUrl, 'POST', `/api/rcm/remittances/${batchId}/comparison${Q}`, json(body));

const comparisonAudits = (db) =>
  auditRows(db).filter((r) => r.resource_type === 'rcm_remittance_comparison');

// ─────────────────────────────────────────────────────────────────────────────
// THE LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

test('marking a check the same records the verdict, the person and the instant', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await answer(app, { verdict: 'same' });
    assert.equal(res.status, 200);
    assert.equal(res.body.verdict, 'same');
    assert.equal(res.body.recorded, true);
    assert.equal(res.body.revision, 1);

    const row = db.table('rcm_payment_batches')[0];
    assert.equal(row.comparison_verdict, 'same');
    assert.ok(row.comparison_at, 'an answer must carry its instant');
    assert.ok(row.comparison_by, 'and the person — an anonymous answer is not evidence');
    assert.equal(row.comparison_reason, null, 'a "same" carries no reason');
    assert.equal(row.comparison_note, null, 'and no note');
    assert.equal(row.comparison_revision, 1);
  });
});

test('marking a check off records the reason AND the sentence', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await answer(app, {
      verdict: 'differed',
      reason: 'payment_amount',
      note: 'App had 150.00, the carrier paid 142.30.',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.verdict, 'differed');
    assert.equal(res.body.reason, 'payment_amount');

    const row = db.table('rcm_payment_batches')[0];
    assert.equal(row.comparison_verdict, 'differed');
    assert.equal(row.comparison_reason, 'payment_amount');
    assert.equal(row.comparison_note, 'App had 150.00, the carrier paid 142.30.');
    assert.equal(row.comparison_revision, 1);
  });
});

test('a difference with NO note is refused, and nothing is written', async () => {
  /*
   * THE ASSERTION THIS SLICE WOULD BE WORTHLESS WITHOUT.
   *
   * A column of five slugs is a tally, not evidence. Somebody deciding in three
   * weeks whether to switch posting on needs to know WHAT was off, and "the
   * payment amount" without the two figures cannot tell them.
   *
   * Unlike `set_aside_reason`, this is required for EVERY slug and not only for
   * `other`.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await answer(app, { verdict: 'differed', reason: 'write_off' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'COMPARISON_NOTE_REQUIRED');

    const row = db.table('rcm_payment_batches')[0];
    assert.equal(row.comparison_verdict, null, 'a refusal writes nothing');
    assert.equal(row.comparison_revision, 0);
  });
  assert.equal(comparisonAudits(db).length, 0, 'and files no success row');
});

test('a difference with no reason is refused, and the reasons are offered', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await answer(app, { verdict: 'differed', note: 'something was wrong' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'COMPARISON_REASON_REQUIRED');
    assert.ok(res.body.reasons.includes('wrong_target'), 'the closed list ships with the refusal');
    assert.equal(db.table('rcm_payment_batches')[0].comparison_verdict, null);
  });
});

test('an unknown verdict is refused rather than stored', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await answer(app, { verdict: 'mostly' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'COMPARISON_VERDICT_REQUIRED');
    assert.deepEqual(res.body.verdicts, ['same', 'differed']);
  });
});

test('a "same" arriving WITH a reason is refused, not quietly stripped', async () => {
  /*
   * The CHECK constraint would refuse the row anyway, so the choice is between a
   * named 400 and an INTERNAL_ERROR. A body reading "the same, because the
   * payment amount was off" is a client with a bug, and a route that silently
   * dropped the field would hide it until somebody read the database.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await answer(app, { verdict: 'same', reason: 'payment_amount', note: 'x' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'COMPARISON_SAME_TAKES_NO_REASON');
    assert.equal(db.table('rcm_payment_batches')[0].comparison_verdict, null);
  });
});

test('a note longer than the ceiling is refused rather than truncated', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await answer(app, {
      verdict: 'differed',
      reason: 'other',
      note: 'x'.repeat(501),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'NOTE_TOO_LONG');
    assert.equal(db.table('rcm_payment_batches')[0].comparison_verdict, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CHANGING AN ANSWER
// ─────────────────────────────────────────────────────────────────────────────

test('changing an answer is RECORDED — the revision advances and a second audit row is filed', async () => {
  /*
   * She may have said "the same" and found the difference an hour later.
   * Refusing the second answer would leave the record saying the opposite of
   * what she now knows, which is the one outcome that makes this worthless.
   *
   * So the change is accepted — and it is not a silent overwrite: the row counts
   * how many times it has been answered, and `audit_log` carries who did each
   * one and when.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    await answer(app, { verdict: 'same' });
    const res = await answer(app, {
      verdict: 'differed',
      reason: 'patient_portion',
      note: 'The patient owed 30.00, not nothing.',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.revision, 2, 'the second answer is the second answer');

    const row = db.table('rcm_payment_batches')[0];
    assert.equal(row.comparison_verdict, 'differed');
    assert.equal(row.comparison_reason, 'patient_portion');
    assert.equal(row.comparison_revision, 2);
  });
  assert.equal(comparisonAudits(db).length, 2, 'one audit row per answer, not one per check');
});

test('re-sending the SAME answer writes nothing and does not inflate the count', async () => {
  /*
   * The screen may re-send, and a double-click must not make the summary say a
   * check was answered twice. A no-op is a 200 that says so (`recorded: false`)
   * rather than a refusal nobody can act on — the rule `unpark` follows.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    await answer(app, { verdict: 'same' });
    const first = db.table('rcm_payment_batches')[0].comparison_at;

    const res = await answer(app, { verdict: 'same' });
    assert.equal(res.status, 200);
    assert.equal(res.body.recorded, false);
    assert.equal(res.body.revision, 1);

    const row = db.table('rcm_payment_batches')[0];
    assert.equal(row.comparison_revision, 1);
    assert.equal(row.comparison_at, first, 'and the instant does not move');
  });
  assert.equal(comparisonAudits(db).length, 1, 'no second audit row for a no-op');
});

test('the biller’s own sentence is never copied into the audit trail', async () => {
  // PHI-capable by nature — she may name a patient in it — and `audit_log` has
  // no detail column. The trail records that somebody answered this check.
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    await answer(app, {
      verdict: 'differed',
      reason: 'wrong_target',
      note: 'It went to Fixture, Synthetic instead',
    });
  });
  const rows = comparisonAudits(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resource_id, BATCH);
  assert.ok(
    !JSON.stringify(rows[0]).includes('Fixture'),
    'the audit row must not become a second copy of the prose'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// WHEN THE QUESTION CAN BE ASKED
// ─────────────────────────────────────────────────────────────────────────────

test('a check nobody has approved cannot be answered — there is nothing to compare', async () => {
  const db = seed(new FakeRcmDb(), { queue: null });
  await withApp({ db }, async (app) => {
    const res = await answer(app, { verdict: 'same' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'COMPARISON_NOT_APPROVED');
    assert.equal(db.table('rcm_payment_batches')[0].comparison_verdict, null);
  });
});

test('a check that has POSTED refuses a new answer — the one given before it posted stands', async () => {
  const db = seed(new FakeRcmDb(), {
    queueStatus: 'posted',
    comparisonVerdict: 'same',
    comparisonBy: 'billing@carein.ai',
    comparisonAt: new Date('2026-03-03T02:00:00Z'),
    comparisonRevision: 1,
  });
  db.seed('rcm_user_map', [
    { user_key: 'billing@carein.ai', platform_email: 'billing@carein.ai', display_name: 'Billing User' },
  ]);
  await withApp({ db }, async (app) => {
    const res = await answer(app, {
      verdict: 'differed',
      reason: 'write_off',
      note: 'too late',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'COMPARISON_CLOSED');

    const row = db.table('rcm_payment_batches')[0];
    assert.equal(row.comparison_verdict, 'same', 'the recorded answer is untouched');
    assert.equal(row.comparison_revision, 1);
  });
});

test('a check whose posting FAILED can still be answered — nothing reached a chart', async () => {
  /*
   * `failed` and `blocked` are deliberately not closing states. Nothing was
   * written in either, so the hand posting the answer is about is still the only
   * thing that happened — and a retired check in particular WILL be posted by
   * hand, which is exactly the case this exercise is about.
   */
  const db = seed(new FakeRcmDb(), { queueStatus: 'failed' });
  await withApp({ db }, async (app) => {
    const res = await answer(app, { verdict: 'same' });
    assert.equal(res.status, 200);
    assert.equal(db.table('rcm_payment_batches')[0].comparison_verdict, 'same');
  });
});

test('a check belonging to the other practice is NOT FOUND, never found-and-refused', async () => {
  const db = seed(new FakeRcmDb(), { office: 'valley' });
  await withApp({ db }, async (app) => {
    const res = await answer(app, { verdict: 'same' });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'REMITTANCE_NOT_FOUND');
    assert.equal(db.table('rcm_payment_batches')[0].comparison_verdict, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE TIER (D-9)
// ─────────────────────────────────────────────────────────────────────────────

test('the REVIEWER tier can answer — it is worklist hygiene, not a posting act', async () => {
  /*
   * The person who checked over every claim on this check and then put the money
   * into Open Dental by hand is the person who knows the answer. Gating her
   * behind `rcm.write` would make the one record that decides whether posting
   * gets switched on depend on a permission she needs for nothing else.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db, role: 'reviewer' }, async (app) => {
    const res = await answer(app, { verdict: 'same' });
    assert.equal(res.status, 200);
    assert.equal(db.table('rcm_payment_batches')[0].comparison_verdict, 'same');
  });
});

test('a role without rcm.queue is refused before the handler runs', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, role: 'hygienist' }, async (app) => {
    const res = await answer(app, { verdict: 'same' });
    assert.equal(res.status, 403);
    assert.equal(db.table('rcm_payment_batches')[0].comparison_verdict, null);
  });
});

test('the summary is ADMIN ONLY — the tier that owns the switch it informs', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db, role: 'reviewer' }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/comparison/summary${Q}`);
    assert.equal(res.status, 403, 'a reviewer reads her own tally, not the practice’s evidence');
  });
  await withApp({ db, role: 'admin' }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/comparison/summary${Q}`);
    assert.equal(res.status, 200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE TALLY AND THE SUMMARY COUNT WHAT THEY SAY THEY COUNT
// ─────────────────────────────────────────────────────────────────────────────

/** Three answered checks in one office: two the same, one off, newest first. */
function seedAnswers(db) {
  const rows = [
    { id: BATCH, verdict: 'same', at: '2026-03-05T15:00:00Z', check: '1' },
    {
      id: BATCH_2,
      verdict: 'differed',
      reason: 'payment_amount',
      note: 'App had 150.00, the carrier paid 142.30.',
      at: '2026-03-04T15:00:00Z',
      check: '2',
    },
    { id: CLAIM, verdict: 'same', at: '2026-03-03T15:00:00Z', check: '3' },
  ];
  for (const r of rows) {
    seed(db, {
      batchId: r.id,
      queueId: `${r.id.slice(0, 8)}-0000-4000-8000-000000000000`,
      checkNumber: r.check,
      comparisonVerdict: r.verdict,
      comparisonReason: r.reason ?? null,
      comparisonNote: r.note ?? null,
      comparisonBy: 'billing@carein.ai',
      comparisonAt: new Date(r.at),
      comparisonRevision: 1,
    });
  }
  // One UNANSWERED check, so "compared" cannot accidentally mean "exists".
  seed(db, {
    batchId: '9f8e7d6c-5b4a-4392-8180-7f6e5d4c3b2a',
    queueId: '9f8e7d6c-0000-4000-8000-000000000000',
    checkNumber: '4',
  });
  db.seed('rcm_user_map', [
    { user_key: 'billing@carein.ai', platform_email: 'billing@carein.ai', display_name: 'Billing User' },
  ]);
  return db;
}

test('the tally counts ANSWERED checks — not every check, and not every claim', async () => {
  const db = seedAnswers(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/comparison/tally${Q}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.compared, 3, 'the unanswered fourth check is not "compared"');
    assert.equal(res.body.same, 2);
    assert.equal(res.body.differed, 1);
    assert.equal(res.body.latestDifference.reason, 'payment_amount');
  });
});

test('the run counts the most recent answers IN A ROW, and stops at the first difference', async () => {
  /*
   * The number the decision gets made from, and the reason it is not a
   * proportion: nine matching checks followed by one that differed averages the
   * same as one that differed followed by nine matching, and they mean opposite
   * things.
   *
   * Newest first here is `same`, then `differed` — so the run is exactly 1, even
   * though two of the three came out the same.
   */
  const db = seedAnswers(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/comparison/tally${Q}`);
    assert.equal(res.body.matchedRun, 1);
  });
});

test('the tally carries no notes — counts and one date', async () => {
  const db = seedAnswers(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/comparison/tally${Q}`);
    assert.ok(
      !JSON.stringify(res.body).includes('142.30'),
      'a tally is a tally; the sentences live on the checks and in the summary'
    );
  });
});

test('the summary names every check that did not match, with its reason and its sentence', async () => {
  const db = seedAnswers(new FakeRcmDb());
  await withApp({ db, role: 'admin' }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/comparison/summary${Q}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.compared, 3);
    assert.equal(res.body.differences.length, 1);
    assert.equal(res.body.differences[0].reason, 'payment_amount');
    assert.equal(res.body.differences[0].note, 'App had 150.00, the carrier paid 142.30.');
    assert.equal(res.body.differences[0].answeredBy, 'Billing User', 'the person, not a key');
  });
});

test('the summary’s date range bounds the counts — and never the run', async () => {
  /*
   * A run of matching checks that a start date happens to cut in half is not a
   * run, so `matchedRun` and `comparedAllTime` are computed over the practice
   * rather than over the window. Reporting a truncated run would overstate the
   * one thing this number exists to be honest about.
   */
  const db = seedAnswers(new FakeRcmDb());
  await withApp({ db, role: 'admin' }, async (app) => {
    const res = await api(
      app.baseUrl,
      'GET',
      `/api/rcm/comparison/summary${Q}&from=2026-03-05&to=2026-03-05`
    );
    assert.equal(res.body.compared, 1, 'one answer fell on that day');
    assert.equal(res.body.same, 1);
    assert.equal(res.body.differed, 0);
    assert.equal(res.body.differences.length, 0);
    assert.equal(res.body.comparedAllTime, 3, 'the practice’s whole total is still reported');
    assert.equal(res.body.matchedRun, 1, 'and the run is the practice’s, not the window’s');
  });
});

test('a malformed date is treated as absent rather than refusing the whole read', async () => {
  // This read's whole job is to be pullable. A 400 over a date box would be a
  // report somebody could not get.
  const db = seedAnswers(new FakeRcmDb());
  await withApp({ db, role: 'admin' }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/comparison/summary${Q}&from=last-tuesday`);
    assert.equal(res.status, 200);
    assert.equal(res.body.from, null);
    assert.equal(res.body.compared, 3);
  });
});

test('the answer comes back on the check’s own detail read', async () => {
  const db = seedAnswers(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'GET', `/api/rcm/remittances/${BATCH_2}${Q}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.remittance.comparisonVerdict, 'differed');
    assert.equal(res.body.remittance.comparisonReason, 'payment_amount');
    assert.equal(res.body.remittance.comparisonRevision, 1);
    assert.equal(res.body.remittance.comparisonBy, 'Billing User');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE THAT MATTERS: POSTING IS UNAFFECTED
// ─────────────────────────────────────────────────────────────────────────────

/** Roland's real Category-32 rows (RCM_OD_WRITES §Probe C). Configuration, not PHI. */
const ROLAND_DEFINITIONS = [
  { DefNum: 296, Category: 32, ItemName: 'Check', isHidden: 'false' },
  { DefNum: 297, Category: 32, ItemName: 'EFT', isHidden: 'false' },
  { DefNum: 472, Category: 32, ItemName: 'Insurance Check', isHidden: 'false' },
  { DefNum: 12, Category: 1, ItemName: 'Insurance Write-off', ItemValue: '-', isHidden: 'false' },
  { DefNum: 260, Category: 1, ItemName: 'Insurance Adjustment', ItemValue: '+', isHidden: 'false' },
  { DefNum: 131, Category: 18, ItemName: 'Insurance', isHidden: 'false' },
];

const ROLAND_PREFERENCES = [
  { PrefName: 'ClaimPaymentBatchOnly', ValueString: '0' },
  { PrefName: 'ShowAutoDeposit', ValueString: '0' },
  { PrefName: 'RigorousAccounting', ValueString: '2' },
];

const DRAIN_QUEUE = QUEUE_2;
const DRAIN_LINE = 'c5a1f3d2-8b4e-4f69-9012-6d7e8f9a0b1c';
const DRAIN_CLAIM = 'e7c3b5f4-6d60-4b81-9234-4f5a6b7c8d9e';

function odFixture() {
  return new FakeOd({
    writable: true,
    definitions: ROLAND_DEFINITIONS,
    preferences: ROLAND_PREFERENCES,
    claims: [
      {
        ClaimNum: 53648,
        PatNum: 12827,
        ClaimStatus: 'W',
        DateService: '2026-03-02',
        ClaimFee: 210.0,
        DateReceived: '0001-01-01',
        ClaimNote: '',
      },
    ],
    claimProcs: [
      {
        ClaimProcNum: 533930,
        ClaimNum: 53648,
        ProcNum: 405237,
        Status: 'NotReceived',
        FeeBilled: 210.0,
        InsPayAmt: 0,
        WriteOff: 0,
        DedApplied: 0,
        DateCP: '2026-08-13',
        IsTransfer: false,
        ClaimPaymentNum: 0,
      },
    ],
  });
}

/** A check with a fully-formed approved posting, ready for a real run. */
function seedPostable(db) {
  db.seed('rcm_user_map', [
    {
      user_key: 'billing@carein.ai',
      platform_email: 'billing@carein.ai',
      display_name: 'Billing User',
      active: true,
    },
  ]);
  seed(db, { batchId: BATCH, queue: null });
  db.seed('rcm_posting_queue', [
    {
      queue_id: DRAIN_QUEUE,
      office_id: 'roland',
      batch_id: BATCH,
      remittance_key: 'roland:830200001',
      status: 'approved',
      is_recoupment: false,
      requires_check: true,
      withdrawn_at: null,
      withdrawn_by: null,
      withdrawn_reason: null,
      withdrawn_note: null,
      carrier_eob_date: '2026-03-01',
      intended_total_cents: 15000,
      posted_total_cents: 0,
      od_claim_payment_num: null,
      approved_by: 'billing@carein.ai',
      approved_at: new Date('2026-03-02T11:00:00Z'),
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
      queue_line_id: DRAIN_LINE,
      queue_id: DRAIN_QUEUE,
      office_id: 'roland',
      position: 1,
      od_claim_proc_num: 533930,
      od_claim_num: 53648,
      claim_id: DRAIN_CLAIM,
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
      recoupment_path: null,
      od_adjustment_num: null,
      od_supplemental_claim_proc_num: null,
      decided_write_off_cents: null,
      decided_reason: null,
      decided_by: null,
      od_writeoff_adjustment_num: null,
      intended_patient_cents: 0,
    },
  ]);
  db.seed('rcm_claims', [
    {
      claim_id: DRAIN_CLAIM,
      office_id: 'roland',
      claim_number: '53648',
      patient_name: 'Test 2, Stedi',
      od_claim_num: 53648,
      od_match_status: 'confirmed',
      posting_queue_id: DRAIN_QUEUE,
      od_match_snapshot: { version: 2, office: 'roland', candidates: [], confirmed: {} },
      od_patient_id: null,
    },
  ]);
  return db;
}

function drainCtx(db, od) {
  return {
    pool: db,
    req: {
      user: { email: 'billing@carein.ai', name: 'Billing User' },
      tenant: { id: 'T1', slug: 'carein' },
      ip: '127.0.0.1',
      method: 'POST',
      originalUrl: '/api/rcm/posting/drain?office=roland',
    },
    office: 'roland',
    operator: 'Billing User',
    drainedBy: 'billing@carein.ai',
    snapshotVersion: 2,
    transport: {
      officeKey: 'roland',
      officeName: 'Roland Family Dental',
      get: (path, params, opts) => od.client.apiGetRaw(path, params, opts),
      write: (method, path, body, opts) => od.client.apiWriteRaw(method, path, body, opts),
    },
  };
}

/** Every Open Dental call, stripped of the wall-clock and id noise a run mints. */
const transcriptOf = (od) => od.calls.map((c) => `${c.verb || 'GET'} ${c.path}`);

/** The posting's own row, with the timing columns a second run cannot reproduce. */
function planShape(db) {
  const plan = db.table('rcm_posting_queue').find((r) => r.queue_id === DRAIN_QUEUE);
  const line = db.table('rcm_posting_queue_line').find((r) => r.queue_line_id === DRAIN_LINE);
  const drop = (row, keys) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (keys.some((rx) => rx.test(k))) continue;
      out[k] = v instanceof Date ? '<instant>' : v;
    }
    return out;
  };
  return {
    plan: drop(plan, [/_at$/, /^readback$/]),
    line: drop(line, [/_at$/, /^readback$/]),
  };
}

test('POSTING IS BYTE-IDENTICAL WITH AND WITHOUT AN ANSWER RECORDED', async () => {
  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * THE LOAD-BEARING TEST OF THIS SLICE
   * ═══════════════════════════════════════════════════════════════════════════
   * The capture sits on the screen where money is authorised, two panels above
   * the button that posts it. If answering the question could change what posts,
   * then the honest answer carries a cost — and every argument for asking her at
   * all assumes it carries none.
   *
   * So this does not assert that the code "does not touch posting". It RUNS the
   * real posting, twice, against two databases identical but for one thing: the
   * first has an answer recorded through the real HTTP route, the second has
   * none. Then it compares what reached Open Dental, in order, and the rows the
   * run left behind.
   *
   * §15.1a's rule is why the answer is recorded through the ROUTE rather than
   * seeded: a hand-written fixture would be a claim about what the route stores,
   * and the place a real coupling would hide.
   */
  odPacer._resetForTests();
  odPacer._setIntervalForTests(1);
  odOfficeConfig._resetForTests();

  // ── A: a check somebody answered ──────────────────────────────────────────
  const answered = seedPostable(new FakeRcmDb());
  await withApp({ db: answered }, async (app) => {
    const res = await answer(app, {
      verdict: 'differed',
      reason: 'write_off',
      note: 'The office absorbed 60.00; the app had nothing.',
    });
    assert.equal(res.status, 200, 'the fixture must EARN its pass — the answer really recorded');
    assert.equal(res.body.recorded, true);
  });
  assert.equal(
    answered.table('rcm_payment_batches')[0].comparison_verdict,
    'differed',
    'and the column really carries it, so the two databases really do differ'
  );

  // ── B: the same check, unanswered ─────────────────────────────────────────
  const untouched = seedPostable(new FakeRcmDb());
  assert.equal(untouched.table('rcm_payment_batches')[0].comparison_verdict, null);

  odOfficeConfig._resetForTests();
  const odA = odFixture();
  const withAnswer = await postingDrain.drainOffice(drainCtx(answered, odA));

  odOfficeConfig._resetForTests();
  const odB = odFixture();
  const without = await postingDrain.drainOffice(drainCtx(untouched, odB));

  // The run must actually have DONE something, or this proves nothing at all.
  assert.ok(withAnswer.ran > 0, 'the posting run must have posted something to compare');
  assert.deepEqual(
    { ran: withAnswer.ran, posted: withAnswer.posted, blocked: withAnswer.blocked },
    { ran: without.ran, posted: without.posted, blocked: without.blocked },
    'the same outcome'
  );

  assert.deepEqual(
    transcriptOf(odA),
    transcriptOf(odB),
    'the same Open Dental calls, in the same order — an answer cannot add, remove or reorder one'
  );
  assert.ok(transcriptOf(odA).length > 0, 'and there were calls to compare');

  assert.deepEqual(
    planShape(answered),
    planShape(untouched),
    'and the rows the run left are the same but for the instants'
  );

  // Belt and braces: the answer survived the posting untouched. A run that
  // cleared it would be a coupling in the other direction.
  const row = answered.table('rcm_payment_batches')[0];
  assert.equal(row.comparison_verdict, 'differed');
  assert.equal(row.comparison_revision, 1);
});
