'use strict';

/**
 * THE TWO WORKLIST STATES — parked, and set aside.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS AT STAKE
 * ═════════════════════════════════════════════════════════════════════════════
 * `needsAttention` is the module's one signal, and its whole value is that it
 * cries wolf as rarely as possible. Stage A adds the first two things that can
 * change what a check says about itself WITHOUT anybody doing any billing work,
 * so both have to be exactly as strong as they claim and no stronger:
 *
 *   PARKED must NOT hide anything. It is a note to a person. A "save for
 *   tomorrow" that quietly dropped a check out of the counts would be a way to
 *   lose work that looks like a convenience — the single worst outcome available
 *   in this slice.
 *
 *   SET ASIDE must hide exactly one thing — the attention signal — and nothing
 *   else. Not the row, not the record, not a posting, not money, and not
 *   irreversibly.
 *
 * Booted through the REAL /api/rcm stack, the way `workbench.test.js` does it:
 * auth gate → tenantContext → requireModule('rcm') → requireReadWrite → the real
 * router. A test that called a handler directly would pass with `requireOffice`
 * deleted from index.js, and would say nothing about the D-9 tier.
 *
 * NO REAL PATIENTS. Every name and number below is synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeRcmDb, bootRcmApp, api, auditRows } = require('./rcmTestUtils');

const BATCH = '8acb0e32-35ae-5cd8-9692-7b5e318a31c2';
const CLAIM = 'd1e2b359-a8d7-51a8-978c-7adf27bccc8d';
const OTHER_BATCH = '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9';

/** One check, one claim — the minimum the attention predicate reads. */
function seed(db, over = {}) {
  const office = over.office || 'roland';
  const batchId = over.batchId || BATCH;
  const claimId = over.claimId || CLAIM;
  db.seed('rcm_payment_batches', [
    {
      batch_id: batchId,
      office_id: office,
      payer: 'SYNTHETIC DENTAL',
      check_number: '830200001',
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
      parked_at: over.parkedAt ?? null,
      parked_by: over.parkedBy ?? null,
      parked_note: over.parkedNote ?? null,
      set_aside_at: over.setAsideAt ?? null,
      set_aside_by: over.setAsideBy ?? null,
      set_aside_reason: over.setAsideReason ?? null,
      set_aside_reason_note: over.setAsideNote ?? null,
    },
  ]);
  db.seed('rcm_claims', [
    {
      claim_id: claimId,
      office_id: office,
      claim_number: '53648',
      check_number: '830200001',
      patient_name: 'Fixture, Synthetic',
      od_patient_id: null,
      od_claim_num: null,
      payer: 'SYNTHETIC DENTAL',
      service_date: '2026-03-02',
      received_date: '2026-03-02',
      status: 'pending_review',
      payment_status: 'unpaid',
      insurance_type: 'primary',
      total_billed_cents: 21000,
      total_allowed_cents: 15000,
      total_paid_cents: 15000,
      total_deductible_cents: 0,
      patient_balance_cents: 0,
      needs_review_reasons: [],
      confidence: 95,
      od_match_status: 'not_run',
      od_match_snapshot: null,
      od_match_at: null,
      od_match_confirmed_at: null,
      od_matched_by: null,
      // Deliberately UNREVIEWED, so the check needs attention by default and the
      // set-aside assertions have something real to silence.
      reviewed_at: null,
      reviewed_by: null,
      review_note: null,
      created_at: new Date('2026-03-02T10:00:00Z'),
    },
  ]);
  db.seed('rcm_batch_claim_payments', [
    {
      batch_claim_payment_id: '5f46bb33-d78e-573d-87a6-bb42a7bd7478',
      batch_id: batchId,
      claim_id: claimId,
      office_id: office,
      position: 1,
      paid_cents: 15000,
    },
  ]);
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

const Q = '?office=roland';
const json = (body) => ({ body: JSON.stringify(body), json: true });

const listing = (app, view) =>
  api(app.baseUrl, 'GET', `/api/rcm/remittances${Q}${view ? `&view=${view}` : ''}`);

// ─────────────────────────────────────────────────────────────────────────────
// PARKED — a note to a person, and nothing more
// ─────────────────────────────────────────────────────────────────────────────

test('parking a check records who, when and their own words', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/park${Q}`,
      json({ note: 'Waiting on the carrier to resend' })
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.parked, true);

    const row = db.table('rcm_payment_batches')[0];
    assert.ok(row.parked_at, 'a parked check must carry its instant');
    assert.ok(row.parked_by, 'and the person — the whole point is whose note it is');
    assert.equal(row.parked_note, 'Waiting on the carrier to resend');
  });
});

test('parking HIDES NOTHING — the check still needs attention and is still counted', async () => {
  /*
   * THE MOST IMPORTANT ASSERTION IN THIS FILE.
   *
   * "Save for tomorrow" is a convenience. If it took a check out of the queue it
   * would be a way to lose work that looks like a convenience, which is worse
   * than not having it at all. `set-aside` is the action that hides, it says so
   * on the button, and it demands a reason.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const before = await listing(app, 'attention');
    assert.equal(before.body.needsAttentionCount, 1);

    await api(app.baseUrl, 'POST', `/api/rcm/remittances/${BATCH}/park${Q}`, json({}));

    const after = await listing(app, 'attention');
    assert.equal(after.body.needsAttentionCount, 1, 'parking must not change the count');
    assert.equal(after.body.remittances.length, 1, 'nor drop the row out of the view');
    assert.equal(after.body.remittances[0].needsAttention, true);
    assert.equal(after.body.parkedCount, 1, 'and the parked count is its own, separate fact');
  });
});

test('re-parking MOVES the stamp — the second time is the one you meant', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/park${Q}`,
      json({ note: 'first' })
    );
    const first = db.table('rcm_payment_batches')[0].parked_at;

    await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/park${Q}`,
      json({ note: 'second' })
    );
    const row = db.table('rcm_payment_batches')[0];
    assert.equal(row.parked_note, 'second');
    assert.ok(row.parked_at >= first, 'the newer instant wins');
  });
});

test('un-parking clears the actor and the note as well as the stamp', async () => {
  // The schema's pairing CHECK demands it, and it is right: an actor left behind
  // on an un-parked row is a name a screen would print beside a check nobody is
  // holding.
  const db = seed(new FakeRcmDb(), {
    parkedAt: new Date('2026-03-04T22:55:00Z'),
    parkedBy: 'u-1',
    parkedNote: 'back tomorrow',
  });
  db.seed('rcm_user_map', [
    { user_key: 'u-1', platform_email: 'billing@carein.ai', display_name: 'Billing User' },
  ]);

  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/remittances/${BATCH}/unpark${Q}`, json({}));
    assert.equal(res.status, 200);
    assert.equal(res.body.wasParked, true);

    const row = db.table('rcm_payment_batches')[0];
    assert.equal(row.parked_at, null);
    assert.equal(row.parked_by, null);
    assert.equal(row.parked_note, null);
  });
});

test('un-parking a check nobody parked is a 200, not a refusal', async () => {
  /*
   * The SCREEN fires this on every open of a check. If an un-parked check were a
   * 409, every ordinary visit would produce an error nobody can act on — and the
   * page would have to learn a rule that exists only because the route was
   * strict for its own sake.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/remittances/${BATCH}/unpark${Q}`, json({}));
    assert.equal(res.status, 200);
    assert.equal(res.body.wasParked, false, 'and it SAYS nothing changed');
  });
  // No audit row for a no-op: one per page-open would bury every real event.
  assert.equal(auditRows(db).filter((r) => r.resource_type === 'rcm_remittance_park').length, 0);
});

test('the parked note is never copied into the audit trail', async () => {
  // PHI-capable by nature — a biller may name a patient in it — and `audit_log`
  // has no detail column. The trail records that somebody did this to this row.
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/park${Q}`,
      json({ note: 'Fixture, Synthetic is disputing this' })
    );
  });
  const rows = auditRows(db).filter((r) => r.resource_type === 'rcm_remittance_park');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resource_id, BATCH);
  assert.ok(
    !JSON.stringify(rows[0]).includes('disputing'),
    'the audit row must not become a second copy of the prose'
  );
});

test('a note longer than the ceiling is refused rather than truncated', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/park${Q}`,
      json({ note: 'x'.repeat(501) })
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'NOTE_TOO_LONG');
    assert.equal(db.table('rcm_payment_batches')[0].parked_at, null, 'and nothing was written');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SET ASIDE — out of the counts, and out of nothing else
// ─────────────────────────────────────────────────────────────────────────────

test('setting a check aside takes it out of needs-attention and says why', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    assert.equal((await listing(app, 'attention')).body.needsAttentionCount, 1);

    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/set-aside${Q}`,
      json({ reason: 'target_gone' })
    );
    assert.equal(res.status, 200);

    const after = await listing(app, 'attention');
    assert.equal(after.body.needsAttentionCount, 0);
    assert.equal(after.body.remittances.length, 0);
    assert.equal(after.body.setAsideCount, 1);
  });
});

test('a set-aside check keeps every one of its facts, and gains four', async () => {
  // NOT a delete and NOT a hide: `view=all` still holds it, and it says on its
  // face who set it aside, when, and why.
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/set-aside${Q}`,
      json({ reason: 'duplicate', note: 'The payer re-sent this under a new check number' })
    );

    const all = await listing(app, 'all');
    assert.equal(all.body.remittances.length, 1);
    const row = all.body.remittances[0];
    assert.equal(row.payer, 'SYNTHETIC DENTAL');
    assert.equal(row.totalAmountCents, 15000);
    assert.equal(row.setAsideReason, 'duplicate');
    assert.equal(row.setAsideNote, 'The payer re-sent this under a new check number');
    assert.ok(row.setAsideAt);
    assert.equal(row.setAsideBy, 'Billing User');
    // The one observation it keeps, so a screen can say WHY the row is quiet.
    assert.deepEqual(row.attentionReasons, []);
    assert.deepEqual(row.attentionObservations, ['set_aside']);
  });
});

test('it is findable under its own view', async () => {
  const db = seed(new FakeRcmDb());
  seed(db, { batchId: OTHER_BATCH, claimId: '2c3d4e5f-6071-4829-93a4-b5c6d7e8f901' });
  await withApp({ db }, async (app) => {
    await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/set-aside${Q}`,
      json({ reason: 'not_ours' })
    );

    const aside = await listing(app, 'set_aside');
    assert.equal(aside.body.view, 'set_aside');
    assert.equal(aside.body.remittances.length, 1);
    assert.equal(aside.body.remittances[0].batchId, BATCH);
    // …and only it. The other check is untouched.
    assert.equal(aside.body.needsAttentionCount, 1);
  });
});

test('it is reversible, and restoring clears the stamps rather than keeping them as history', async () => {
  // A screen reading "set aside on Aug 30 — currently in the queue" is describing
  // two states at once. The audit row is the history.
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/set-aside${Q}`,
      json({ reason: 'posted_by_hand' })
    );
    const res = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/restore${Q}`,
      json({})
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.wasSetAside, true);

    const row = db.table('rcm_payment_batches')[0];
    assert.equal(row.set_aside_at, null);
    assert.equal(row.set_aside_by, null);
    assert.equal(row.set_aside_reason, null);
    assert.equal(row.set_aside_reason_note, null);

    assert.equal((await listing(app, 'attention')).body.needsAttentionCount, 1, 'and it is back');
  });
});

test('a reason is required, and the closed set is offered rather than guessed at', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    for (const body of [{}, { reason: '' }, { reason: 'because_i_said_so' }]) {
      const res = await api(
        app.baseUrl,
        'POST',
        `/api/rcm/remittances/${BATCH}/set-aside${Q}`,
        json(body)
      );
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'SET_ASIDE_REASON_REQUIRED');
      assert.ok(Array.isArray(res.body.reasons) && res.body.reasons.includes('target_gone'));
    }
    assert.equal(db.table('rcm_payment_batches')[0].set_aside_at, null);
  });
});

test("'something else' demands the biller's own words", async () => {
  // Otherwise the slug is a silent shrug, and the queue has lost work nobody can
  // later explain — the whole thing the required reason exists to prevent.
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const refused = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/set-aside${Q}`,
      json({ reason: 'other' })
    );
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'SET_ASIDE_NOTE_REQUIRED');

    const ok = await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/set-aside${Q}`,
      json({ reason: 'other', note: 'The carrier voided it and is re-issuing' })
    );
    assert.equal(ok.status, 200);
  });
});

test('setting aside touches no posting, no claim and no chart', async () => {
  /*
   * The line between this and `withdrawn`. Retiring a POSTING decides money will
   * never reach a chart through CareIN and cannot be undone; this decides a
   * CHECK is not worth a biller's morning and can be undone by anybody. If
   * set-aside could reach a posting, the reversible action would be able to
   * cause the irreversible consequence.
   */
  const db = seed(new FakeRcmDb());
  db.seed('rcm_posting_queue', [
    {
      queue_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      office_id: 'roland',
      batch_id: BATCH,
      remittance_key: 'roland:830200001',
      status: 'approved',
      intended_total_cents: 15000,
      posted_total_cents: 0,
      attempt_count: 0,
      approved_at: new Date('2026-03-04T15:00:00Z'),
      approved_by: null,
    },
  ]);
  await withApp({ db }, async (app) => {
    await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/set-aside${Q}`,
      json({ reason: 'target_gone' })
    );
    const plan = db.table('rcm_posting_queue')[0];
    assert.equal(plan.status, 'approved', 'the posting is untouched');
    assert.equal(plan.withdrawn_at ?? null, null, 'and certainly not retired');

    const claim = db.table('rcm_claims')[0];
    assert.equal(claim.reviewed_at, null, 'and no claim was dispositioned on anybody\'s behalf');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The boundaries — office, tier, and a bad id
// ─────────────────────────────────────────────────────────────────────────────

test('another practice\'s check is NOT FOUND, not refused', async () => {
  // Found-and-refused tells a prober the id exists. `office_id` is in the WHERE.
  const db = seed(new FakeRcmDb(), { office: 'valley' });
  await withApp({ db }, async (app) => {
    for (const path of ['park', 'unpark', 'set-aside', 'restore']) {
      const res = await api(
        app.baseUrl,
        'POST',
        `/api/rcm/remittances/${BATCH}/${path}${Q}`,
        json({ reason: 'duplicate' })
      );
      assert.equal(res.status, 404, path);
      assert.equal(res.body.code, 'REMITTANCE_NOT_FOUND', path);
    }
  });
});

test('a malformed id is NOT FOUND rather than a 500', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/remittances/not-a-uuid/park${Q}`, json({}));
    assert.equal(res.status, 404);
  });
});

test('the queue tier may park and set aside — the same authority as marking a claim reviewed', async () => {
  /*
   * D-9. A `reviewer` holds `rcm.read` + `rcm.queue` and NOT `rcm.write`.
   * Marking a claim reviewed also takes a check out of the needs-attention view
   * and has run on `rcm.queue` since 6a; these are the same act on the same
   * queue, and both are reversible. Anything narrower would mean a person who
   * can disposition every claim on a check cannot say "I am coming back to this
   * one" about the check.
   */
  const db = seed(new FakeRcmDb());
  await withApp({ db, role: 'reviewer' }, async (app) => {
    for (const [path, body] of [
      ['park', {}],
      ['unpark', {}],
      ['set-aside', { reason: 'duplicate' }],
      ['restore', {}],
    ]) {
      const res = await api(
        app.baseUrl,
        'POST',
        `/api/rcm/remittances/${BATCH}/${path}${Q}`,
        json(body)
      );
      assert.equal(res.status, 200, `${path} → ${res.status} ${JSON.stringify(res.body)}`);
    }
  });
});

test('SET ASIDE IS QUIET, NOT INVISIBLE — every tier that can read the list can see it', async () => {
  /*
   * THE CONDITION ON THE `rcm.queue` RULING.
   *
   * Setting a check aside is allowed to take it out of the counts. It is NOT
   * allowed to put it out of reach of the biller whose queue it left — a state
   * you can undo has to be a state you can find, or "reversible" is a property
   * only the person who pressed it can use, and only while they remember.
   *
   * `GET /remittances` is a plain GET under the mount's `rcm.read`, and the view
   * is a query param with no gate of its own. This asserts that across every
   * tier rather than trusting the absence of a middleware call: a gate added
   * here later would fail this test rather than quietly hide a queue.
   */
  for (const role of ['reviewer', 'rcm_biller', 'office', 'admin']) {
    const db = seed(new FakeRcmDb(), {
      setAsideAt: new Date('2026-03-04T23:00:00Z'),
      setAsideReason: 'target_gone',
    });
    await withApp({ db, role }, async (app) => {
      const view = await listing(app, 'set_aside');
      assert.equal(view.status, 200, role);
      assert.equal(view.body.remittances.length, 1, `${role} cannot see the set-aside view`);
      assert.equal(view.body.setAsideCount, 1, `${role} cannot see the set-aside count`);
      // …and it is still in `all`, which is where somebody who does not know
      // about the filter would look.
      assert.equal((await listing(app, 'all')).body.remittances.length, 1, role);
    });
  }
});

test('an office is required, like every other route in this module', async () => {
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await api(app.baseUrl, 'POST', `/api/rcm/remittances/${BATCH}/park`, json({}));
    assert.equal(res.status, 400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The list's own contract
// ─────────────────────────────────────────────────────────────────────────────

test('an unknown view falls back to `all` rather than refusing the whole list', async () => {
  // Refusing a list over a typo in a display preference is the worse failure —
  // the same rule the `attention`/`all` pair has had since 6b.
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    const res = await listing(app, 'nonsense');
    assert.equal(res.status, 200);
    assert.equal(res.body.view, 'all');
    assert.equal(res.body.remittances.length, 1);
  });
});

test('the parked view excludes a check that was later set aside', async () => {
  // Two true stamps, one stronger and later decision. The screen reports the
  // decision somebody actually made last.
  const db = seed(new FakeRcmDb());
  await withApp({ db }, async (app) => {
    await api(app.baseUrl, 'POST', `/api/rcm/remittances/${BATCH}/park${Q}`, json({}));
    await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/set-aside${Q}`,
      json({ reason: 'target_gone' })
    );

    const parked = await listing(app, 'parked');
    assert.equal(parked.body.remittances.length, 0);
    assert.equal(parked.body.parkedCount, 0);
    assert.equal((await listing(app, 'set_aside')).body.remittances.length, 1);
  });
});

test('every view counts the same population, so no two numbers describe two sets', async () => {
  // The Slice 6a defect this module has been careful about ever since: a filter
  // applied to a page while the header counted the office.
  const db = seed(new FakeRcmDb());
  seed(db, { batchId: OTHER_BATCH, claimId: '2c3d4e5f-6071-4829-93a4-b5c6d7e8f901' });
  await withApp({ db }, async (app) => {
    await api(
      app.baseUrl,
      'POST',
      `/api/rcm/remittances/${BATCH}/set-aside${Q}`,
      json({ reason: 'duplicate' })
    );
    await api(app.baseUrl, 'POST', `/api/rcm/remittances/${OTHER_BATCH}/park${Q}`, json({}));

    for (const view of ['attention', 'parked', 'set_aside', 'all']) {
      const res = await listing(app, view);
      assert.equal(res.body.total, 2, `${view}: total is the whole office`);
      assert.equal(res.body.needsAttentionCount, 1, `${view}: one live check needs somebody`);
      assert.equal(res.body.parkedCount, 1, `${view}: one is saved for tomorrow`);
      assert.equal(res.body.setAsideCount, 1, `${view}: one is set aside`);
    }
  });
});
