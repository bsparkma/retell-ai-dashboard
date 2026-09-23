'use strict';

/**
 * The `edited` decision: a human types the fee they actually hold, and THAT is
 * what reaches Open Dental.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS DECISION EXISTS AT ALL
 * ═════════════════════════════════════════════════════════════════════════════
 * The commonest warned row in the corpus is the multi-column one:
 *
 *     D2740   Crown - porcelain/ceramic   1,150.00   920.00   805.00
 *
 * The parser takes the first amount and says so. The office knows their
 * contract is Tier 2. Before this, their only answers were to ACCEPT $1,150 —
 * a number they know is wrong, posted into a live practice — or to EXCLUDE the
 * code, leaving a crown with no fee in the schedule. Both are worse than typing
 * $920.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE PIN
 * ═════════════════════════════════════════════════════════════════════════════
 * `a posted batch writes the EDITED value, not the parsed one` is the test the
 * slice brief asks to be negative-tested. It drives the whole stack — HTTP
 * PATCH, HTTP POST, the background job, the Open Dental writer — and then reads
 * the practice's fee schedule out of `fakeOd`'s store and asserts the number in
 * it. Bypassing `effectiveFeeCents` in `postJob.js` turns exactly that test
 * red, because nothing else in the suite looks at what amount landed.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * AND THE PARSED VALUE SURVIVES
 * ═════════════════════════════════════════════════════════════════════════════
 * Every assertion about an edited row also checks `fee_cents` is untouched.
 * That column is the only record of what the payer's file said, and this
 * module's whole reason for existing is that the importer it was ported from
 * made its interpretations in place and in silence.
 *
 * NO REAL PATIENT DATA — a fee schedule carries procedure codes and money and
 * never a patient. The fixtures are synthetic regardless.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { withApp, api, filePart, auditRows, fakeOd, waitForStatus } = require('./feesTestUtils');
const fx = require('../../services/fees/feeFixtures');
const migration = require('../../migrations-tenant/1789100000000_fees_edited_rows');
const { effectiveFeeCents, EFFECTIVE_FEE_CENTS_SQL } = require('../../services/fees/effectiveFee');
const { MAX_FEE_CENTS } = require('../../services/fees/feeValues');

const PDF = 'application/pdf';

const CODE_NUMS = { D2740: 15, D2750: 17 };

const SCHEDULES = [
  { feeSchedNum: 55, description: 'Meridian Tier 2', feeSchedType: 'Normal', isHidden: false, isGlobal: true },
];

/** Tier 1, which the parser reads; Tier 2, which this office actually holds. */
const D2740_PARSED = 115000;
const D2740_HELD = 92000;
const D2750_PARSED = 109000;
const D2750_HELD = 87200;

/** Upload the multi-column PDF: two rows, BOTH warned (ambiguous_amount). */
async function uploadTiers(app, office = 'roland') {
  const res = await api(app.baseUrl, 'POST', `/api/fees/imports?office=${office}`, {
    body: filePart(fx.syntheticFeePdf(fx.PDF_MULTI_COLUMN), 'tiers.pdf', PDF),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.batch.batchId;
}

const patchRow = (app, batchId, rowId, body, office = 'roland') =>
  api(app.baseUrl, 'PATCH', `/api/fees/imports/${batchId}/rows/${rowId}?office=${office}`, {
    body: JSON.stringify(body),
    json: true,
  });

const target = (app, batchId, body, office = 'roland') =>
  api(app.baseUrl, 'PUT', `/api/fees/imports/${batchId}/target?office=${office}`, {
    body: JSON.stringify(body),
    json: true,
  });

const doPost = (app, batchId, office = 'roland') =>
  api(app.baseUrl, 'POST', `/api/fees/imports/${batchId}/post?office=${office}`, {
    body: JSON.stringify({}),
    json: true,
  });

/** The stored row for a proc code. */
const rowFor = (app, code) =>
  app.db.table('fees_import_row').find((r) => r.proc_code === code);

// ════════════════════════════════════════════════════════════════════════════
// 1. The migration: the pair CHECKs, in both directions
// ════════════════════════════════════════════════════════════════════════════

function makePgm() {
  const calls = { sql: [], addConstraint: [], addColumns: [], dropColumns: [], dropConstraint: [] };
  return {
    calls,
    sql: (t) => calls.sql.push(String(t)),
    func: (e) => ({ __func: e }),
    addColumns: (table, cols) => calls.addColumns.push({ table, cols }),
    dropColumns: (table, cols) => calls.dropColumns.push({ table, cols }),
    addConstraint: (table, name, opts) => calls.addConstraint.push({ table, name, opts }),
    dropConstraint: (table, name, opts) => calls.dropConstraint.push({ table, name, opts }),
  };
}

const constraintNamed = (pgm, name) => pgm.calls.addConstraint.find((c) => c.name === name);

test('the decision CHECK is WIDENED to four values, replaced rather than altered', () => {
  const pgm = makePgm();
  migration.up(pgm);

  // Postgres has no "widen a CHECK": the old one must be dropped first, and the
  // DROP must be guarded so this is safe on a database that never got slice 3's.
  assert.ok(
    pgm.calls.sql.some((s) =>
      /DROP CONSTRAINT IF EXISTS fees_import_row_decision_check/.test(s)
    ),
    'the old constraint is dropped, guarded'
  );

  const check = constraintNamed(pgm, 'fees_import_row_decision_check');
  assert.ok(check, 'and re-added');
  for (const decision of migration.ROW_DECISIONS) {
    assert.match(check.opts.check, new RegExp(`'${decision}'`), `${decision} is admitted`);
  }
  assert.deepEqual([...migration.ROW_DECISIONS].sort(), [
    'accepted',
    'edited',
    'excluded',
    'pending',
  ]);
});

test('the pair CHECKs say BOTH directions, which is the point of them', () => {
  const pgm = makePgm();
  migration.up(pgm);

  const value = constraintNamed(pgm, 'fees_import_row_edited_value_check');
  const only = constraintNamed(pgm, 'fees_import_row_edited_only_check');
  assert.ok(value && only, 'both constraints exist');

  // Direction 1: an `edited` row HAS a value, it is not negative, and it is
  // within the same ceiling the parser applies.
  assert.match(value.opts.check, /decision <> 'edited' OR/);
  assert.match(value.opts.check, /edited_fee_cents IS NOT NULL/);
  assert.match(value.opts.check, /edited_fee_cents >= 0/);
  assert.match(value.opts.check, new RegExp(`<= ${MAX_FEE_CENTS}`));
  // `>= 0`, never `> 0`: $0.00 means not covered, bundled, or no charge, and
  // discarding zeros is the reference importer's defect this module was built
  // to stop repeating.
  assert.doesNotMatch(value.opts.check, /edited_fee_cents > 0/);

  // Direction 2 — the half that is easy to omit. Without it a row could carry
  // an override while sitting at `accepted`, and every reader would have to
  // decide for itself whether that counts.
  assert.match(only.opts.check, /decision = 'edited' OR edited_fee_cents IS NULL/);
});

test('the override is a NULLABLE integer column on fees_import_row', () => {
  const pgm = makePgm();
  migration.up(pgm);

  const added = pgm.calls.addColumns.find((a) => a.table === 'fees_import_row');
  assert.ok(added, 'the column is added to the row table, not the batch table');
  const col = added.cols.edited_fee_cents;
  assert.equal(col.type, 'integer', 'integer CENTS — money is never a float here');
  assert.notEqual(col.notNull, true, 'NULL on every row nobody edited');
  // And nothing anywhere touches the parsed column.
  assert.equal(added.cols.fee_cents, undefined);
});

test('nothing is granted, because nothing is created', () => {
  const pgm = makePgm();
  migration.up(pgm);
  // A CREATE without a GRANT is a defect in this repo; an ALTER without one is
  // correct, because a grant follows the table rather than its columns.
  assert.equal(
    pgm.calls.sql.some((s) => /GRANT/i.test(s)),
    false
  );
  assert.equal(
    pgm.calls.sql.some((s) => /audit_log/i.test(s)),
    false,
    'and audit_log is not touched'
  );
});

test('down() moves edited rows OUT before narrowing the CHECK back', () => {
  const pgm = makePgm();
  migration.down(pgm);

  const statements = pgm.calls.sql;
  const moved = statements.findIndex((s) => /SET decision = 'pending'/.test(s));
  const dropped = statements.findIndex((s) =>
    /DROP CONSTRAINT IF EXISTS fees_import_row_decision_check/.test(s)
  );
  assert.ok(moved >= 0, 'the rows are moved');
  assert.ok(dropped > moved, 'and only then is the old vocabulary restored');

  // `pending`, not `accepted`: an edited row's parsed value is the one thing the
  // row proves is NOT the fee this office holds, and the override column is
  // about to be dropped. Nor `excluded`, which the excluded-unwritten CHECK
  // refuses outright on any row that was already written.
  assert.ok(statements.some((s) => /decision = 'edited'/.test(s)));
  assert.equal(
    statements.some((s) => /SET decision = 'accepted'/.test(s)),
    false
  );
  const narrowed = pgm.calls.addConstraint.find(
    (c) => c.name === 'fees_import_row_decision_check'
  );
  assert.doesNotMatch(narrowed.opts.check, /'edited'/);
  assert.deepEqual(pgm.calls.dropColumns[0].cols, ['edited_fee_cents']);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. effectiveFeeCents: one rule, two forms
// ════════════════════════════════════════════════════════════════════════════

test('effectiveFeeCents picks the override ONLY for an edited row', () => {
  assert.equal(
    effectiveFeeCents({ decision: 'edited', fee_cents: D2740_PARSED, edited_fee_cents: D2740_HELD }),
    D2740_HELD
  );
  for (const decision of ['pending', 'accepted', 'excluded']) {
    assert.equal(
      effectiveFeeCents({ decision, fee_cents: D2740_PARSED, edited_fee_cents: null }),
      D2740_PARSED,
      `${decision} posts what the file said`
    );
  }
  // $0.00 is a real fee, and must not read as "no override".
  assert.equal(effectiveFeeCents({ decision: 'edited', fee_cents: 9200, edited_fee_cents: 0 }), 0);
});

test('an edited row with no value THROWS rather than silently posting the parsed one', () => {
  // The pair CHECK makes this unreachable. If it were ever reachable, falling
  // back to `fee_cents` would write the number somebody had corrected away —
  // the failure this whole feature exists to prevent, arriving silently.
  assert.throws(
    () => effectiveFeeCents({ decision: 'edited', fee_cents: 115000, edited_fee_cents: null }),
    /refusing to post the parsed value/
  );
});

test('the SQL form states the rule, and does not lean on a constraint elsewhere', () => {
  // COALESCE(edited_fee_cents, fee_cents) computes the same answer today ONLY
  // because fees_import_row_edited_only_check exists. The CASE is correct on its
  // own terms, which is what a reader is trying to learn from it.
  assert.match(EFFECTIVE_FEE_CENTS_SQL, /CASE WHEN decision = 'edited'/);
  assert.doesNotMatch(EFFECTIVE_FEE_CENTS_SQL, /COALESCE/);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. The endpoint: what it refuses
// ════════════════════════════════════════════════════════════════════════════

test('a negative fee is refused, but ZERO is accepted', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadTiers(app);
    const row = rowFor(app, 'D2740');

    const negative = await patchRow(app, batchId, row.row_id, {
      decision: 'edited',
      feeCents: -100,
    });
    assert.equal(negative.status, 400);
    assert.equal(negative.body.code, 'BAD_FEE');
    assert.match(negative.body.error, /cannot be negative/i);
    assert.equal(rowFor(app, 'D2740').decision, 'pending', 'and nothing was recorded');

    // Zero is a legitimate fee: not covered, bundled, or no charge.
    const zero = await patchRow(app, batchId, row.row_id, { decision: 'edited', feeCents: 0 });
    assert.equal(zero.status, 200, JSON.stringify(zero.body));
    assert.equal(rowFor(app, 'D2740').edited_fee_cents, 0);
  });
});

test('a non-integer, a string and a missing value are all refused', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadTiers(app);
    const row = rowFor(app, 'D2740');

    for (const feeCents of [92000.5, '92000', null, undefined, Number.NaN]) {
      const res = await patchRow(app, batchId, row.row_id, { decision: 'edited', feeCents });
      assert.equal(res.status, 400, `${String(feeCents)} must be refused`);
      assert.equal(res.body.code, 'BAD_FEE');
    }
    // "92000" in particular: a client that sends money as a string is one that
    // will eventually send "1,150.00", and coercion is where rounding gets
    // invented.
    assert.equal(rowFor(app, 'D2740').decision, 'pending');
  });
});

test('a fee past the parser ceiling is refused, not stored', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadTiers(app);
    const row = rowFor(app, 'D2740');

    const res = await patchRow(app, batchId, row.row_id, {
      decision: 'edited',
      feeCents: MAX_FEE_CENTS + 1,
    });
    // A refusal, not a 500 from the integer column overflowing.
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'BAD_FEE');
    assert.match(res.body.error, /larger than any real fee/i);
  });
});

test('a POSTED batch refuses an edit — server-side, not by a disabled input', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadTiers(app);
    await target(app, batchId, { feeSchedNum: 55 });
    for (const row of app.db.table('fees_import_row')) {
      await patchRow(app, batchId, row.row_id, { decision: 'accepted' });
    }
    assert.equal((await doPost(app, batchId)).status, 202);
    await waitForStatus(app, batchId, ['posted', 'post_failed']);

    const row = rowFor(app, 'D2740');
    const res = await patchRow(app, batchId, row.row_id, {
      decision: 'edited',
      feeCents: D2740_HELD,
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'BATCH_NOT_EDITABLE');
    // Editing a row after its fee is in a live practice would make the stored
    // decisions disagree with what was actually written — the record would say
    // $920 while Open Dental held $1,150.
    assert.equal(rowFor(app, 'D2740').decision, 'accepted');
    assert.equal(rowFor(app, 'D2740').edited_fee_cents, null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. The gate: `edited` resolves a warned row
// ════════════════════════════════════════════════════════════════════════════

test('editing a warned row RESOLVES it, and a fully-edited batch becomes ready', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadTiers(app);
    await target(app, batchId, { feeSchedNum: 55 });

    const first = await patchRow(app, batchId, rowFor(app, 'D2740').row_id, {
      decision: 'edited',
      feeCents: D2740_HELD,
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    // One row down, one to go — the batch is still blocked.
    assert.equal(first.body.counts.blocking, 1);
    assert.equal(first.body.status, 'parsed');

    const second = await patchRow(app, batchId, rowFor(app, 'D2750').row_id, {
      decision: 'edited',
      feeCents: D2750_HELD,
    });
    assert.equal(second.body.counts.blocking, 0);
    assert.equal(second.body.counts.edited, 2);
    assert.equal(second.body.status, 'ready', 'nothing is undecided, so it is postable');

    // And the server agrees when asked directly, rather than only in the
    // response to the click that changed it.
    const progress = await api(
      app.baseUrl,
      'GET',
      `/api/fees/imports/${batchId}/progress?office=roland`
    );
    assert.equal(progress.body.progress.blockingCount, 0);
    assert.equal(progress.body.progress.editedCount, 2);
  });
});

test('the totals the confirm dialog states are of EFFECTIVE fees', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadTiers(app);

    // Parsed: 115000 + 109000 = 224000. Edit one row down to Tier 2.
    await patchRow(app, batchId, rowFor(app, 'D2740').row_id, {
      decision: 'edited',
      feeCents: D2740_HELD,
    });
    const res = await patchRow(app, batchId, rowFor(app, 'D2750').row_id, {
      decision: 'accepted',
    });

    // 92000 (edited) + 109000 (accepted as parsed) = 201000.
    assert.equal(res.body.counts.totalCents, D2740_HELD + D2750_PARSED);
    assert.notEqual(
      res.body.counts.totalCents,
      D2740_PARSED + D2750_PARSED,
      'a confirm dialog stating the parsed total would be a person approving a number that never existed'
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Re-deciding
// ════════════════════════════════════════════════════════════════════════════

test('edited -> accepted clears the override; there is no special case', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadTiers(app);
    const rowId = rowFor(app, 'D2740').row_id;

    await patchRow(app, batchId, rowId, { decision: 'edited', feeCents: D2740_HELD });
    assert.equal(rowFor(app, 'D2740').edited_fee_cents, D2740_HELD);

    // A second edit is just a different value.
    await patchRow(app, batchId, rowId, { decision: 'edited', feeCents: 80500 });
    assert.equal(rowFor(app, 'D2740').edited_fee_cents, 80500);

    // Back to accepting the parsed number: the override MUST go, or the row
    // would post one number while reading as another.
    await patchRow(app, batchId, rowId, { decision: 'accepted' });
    assert.equal(rowFor(app, 'D2740').decision, 'accepted');
    assert.equal(rowFor(app, 'D2740').edited_fee_cents, null);

    // And back to undecided, which re-blocks the post.
    const reset = await patchRow(app, batchId, rowId, { decision: 'reset' });
    assert.equal(rowFor(app, 'D2740').decision, 'pending');
    assert.equal(rowFor(app, 'D2740').edited_fee_cents, null);
    assert.equal(rowFor(app, 'D2740').decided_by, null);
    // Both rows of this fixture are warned, and the second was never decided,
    // so undoing the first returns the batch to two blocking rows.
    assert.equal(reset.body.counts.blocking, 2);
    assert.equal(reset.body.status, 'parsed');

    // Through all of it, the file's own number never moved.
    assert.equal(rowFor(app, 'D2740').fee_cents, D2740_PARSED);
  });
});

test('the audit row carries the OLD and NEW values, not just the fact', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadTiers(app);
    await patchRow(app, batchId, rowFor(app, 'D2740').row_id, {
      decision: 'edited',
      feeCents: D2740_HELD,
    });

    const entry = auditRows(app.db)
      .filter((r) => r.resource_type === 'fees_import_row')
      .pop();
    assert.ok(entry, 'an edit is audited');
    assert.equal(entry.action, 'UPDATE');
    // "Somebody edited a row" does not answer "who changed a crown from $1,150
    // to $920, and what did the payer's file actually say".
    assert.match(entry.source_ref, /code:D2740/);
    assert.match(entry.source_ref, new RegExp(`cents:${D2740_PARSED}->${D2740_HELD}`));
    assert.match(entry.source_ref, /decision:pending->edited/);
    assert.match(entry.source_ref, new RegExp(`parsed:${D2740_PARSED}`));
    // ASCII only — these lines get read back through container exec.
    // eslint-disable-next-line no-control-regex
    assert.match(entry.source_ref, /^[\x20-\x7e]+$/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. THE PIN
// ════════════════════════════════════════════════════════════════════════════

test('THE PIN: a posted batch writes the EDITED value into Open Dental', async () => {
  const od = fakeOd({ schedules: SCHEDULES, codeNums: CODE_NUMS });
  await withApp({ od }, async (app) => {
    const batchId = await uploadTiers(app);
    await target(app, batchId, { feeSchedNum: 55 });

    // The office holds Tier 2 on the crown and accepts the parsed Tier 1 on the
    // other, so one row of each kind goes through the same run.
    await patchRow(app, batchId, rowFor(app, 'D2740').row_id, {
      decision: 'edited',
      feeCents: D2740_HELD,
    });
    await patchRow(app, batchId, rowFor(app, 'D2750').row_id, { decision: 'accepted' });

    assert.equal((await doPost(app, batchId)).status, 202);
    const done = await waitForStatus(app, batchId, ['posted', 'post_failed']);
    assert.equal(done.status, 'posted', done.postError || '');

    // ── What the practice's fee schedule now holds. Read out of the store, not
    //    out of the call log, because the store is the practice.
    const fees = [...od.store.values()].filter((f) => f.FeeSched === 55);
    const byCode = Object.fromEntries(fees.map((f) => [f.CodeNum, Math.round(f.Amount * 100)]));

    assert.equal(byCode[CODE_NUMS.D2740], D2740_HELD, 'THE EDITED VALUE, not the parsed one');
    assert.notEqual(byCode[CODE_NUMS.D2740], D2740_PARSED);
    assert.equal(byCode[CODE_NUMS.D2750], D2750_PARSED, 'and an accepted row still posts as parsed');

    // The writer was ASKED for the edited amount — so this cannot pass on a
    // coincidence in the fake's storage.
    const asked = od.calls.writeFee.find((c) => c.codeNum === CODE_NUMS.D2740);
    assert.equal(asked.amountCents, D2740_HELD);

    // ── AND THE FILE'S OWN NUMBER SURVIVES. This is the column that answers
    //    "what did the payer send us", months after somebody corrected it.
    assert.equal(rowFor(app, 'D2740').fee_cents, D2740_PARSED);
    assert.equal(rowFor(app, 'D2740').edited_fee_cents, D2740_HELD);

    // And the audit row for the post records that hands were involved.
    const posted = auditRows(app.db)
      .filter((r) => r.resource_type === 'fees_post')
      .pop();
    assert.match(posted.source_ref, /edited:1/);
    assert.match(posted.source_ref, new RegExp(`cents:${D2740_HELD + D2750_PARSED}`));
  });
});

test('a resume over an edited row compares against the EDITED amount', async () => {
  // The verify-by-read primitive asks Open Dental whether the fee is already
  // there "at the right amount". If that comparison used the parsed value, a
  // resume would see $1,150 ≠ $920, decide the row was unwritten, and write it
  // a second time — or worse, see a stale $1,150 and adopt it as correct.
  const od = fakeOd({
    schedules: SCHEDULES,
    codeNums: CODE_NUMS,
    // The practice already holds the EDITED amount for D2740: exactly the state
    // a run that died between Open Dental's commit and ours leaves behind.
    fees: [{ FeeNum: 700001, FeeSched: 55, CodeNum: CODE_NUMS.D2740, Amount: D2740_HELD / 100 }],
  });
  await withApp({ od }, async (app) => {
    const batchId = await uploadTiers(app);
    await target(app, batchId, { feeSchedNum: 55 });
    await patchRow(app, batchId, rowFor(app, 'D2740').row_id, {
      decision: 'edited',
      feeCents: D2740_HELD,
    });
    await patchRow(app, batchId, rowFor(app, 'D2750').row_id, { decision: 'accepted' });

    await doPost(app, batchId);
    await waitForStatus(app, batchId, ['posted', 'post_failed']);

    // NO WRITE was issued for D2740 — the existing fee was recognised and its
    // FeeNum adopted.
    assert.equal(
      od.calls.writeFee.some((c) => c.codeNum === CODE_NUMS.D2740),
      false,
      'the edited row was recognised as already written'
    );
    assert.equal(rowFor(app, 'D2740').od_fee_num, 700001);
    // And exactly one fee for that code in the schedule, which is the property
    // the whole verify-by-read design exists to keep.
    assert.equal(
      [...od.store.values()].filter(
        (f) => f.FeeSched === 55 && f.CodeNum === CODE_NUMS.D2740
      ).length,
      1
    );
  });
});
