'use strict';

/**
 * /api/fees/imports — route tests (Fee Schedule slice 1).
 *
 * Every test boots the REAL assembled chain (auth gate → tenantContext →
 * requireModule('fees') → requireReadWrite → routes/fees/index.js) and executes
 * the routes' ACTUAL SQL against FakeFeesDb, the batch CHECK constraints and
 * the composite FK included. A test that called the handler directly would pass
 * with the office guard, the module guard or the permission gate deleted, which
 * is three of the things this file exists to prove.
 *
 * THE STAR is `a file that will not parse is STORED as failed`. Everything else
 * supports it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { withApp, api, filePart, auditRows, FakeFeesDb } = require('./feesTestUtils');
const fx = require('../../services/fees/feeFixtures');

const PDF = 'application/pdf';
const CSV = 'text/csv';

/** The clean synthetic schedule, as PDF bytes. */
const cleanPdf = () => fx.syntheticFeePdf(fx.PDF_CLEAN);
/** The clean synthetic schedule, as CSV bytes. */
const cleanCsv = () => Buffer.from(fx.CSV_CLEAN, 'utf8');

/** Upload a file and return the response. */
function post(app, bytes, filename, contentType, query = '?office=roland') {
  return api(app.baseUrl, 'POST', `/api/fees/imports${query}`, {
    body: filePart(bytes, filename, contentType),
  });
}

// ─── THE STAR ───────────────────────────────────────────────────────────────

test('THE STAR: a file that will not parse is STORED as failed, with the reason', async () => {
  await withApp({}, async (app) => {
    const res = await post(app, Buffer.from(fx.CSV_AMBIGUOUS_FEE, 'utf8'), 'meridian.csv', CSV);

    // A refusal, not a success with zero rows. A 200 saying `rowCount: 0` reads
    // as "your schedule has no fees in it", which is a different and false fact.
    assert.equal(res.status, 422);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'CSV_AMBIGUOUS_COLUMNS');
    for (const header of ['UCR Fee', 'Allowed Amount', 'Contracted Fee']) {
      assert.match(res.body.error, new RegExp(header), 'the refusal names the candidates');
    }

    // And the upload is NOT lost. "I uploaded it and nothing happened" is the
    // support ticket a dropped request produces, and it is unanswerable.
    const stored = app.db.table('fees_import_batch');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, 'failed');
    assert.equal(stored[0].failure_code, 'CSV_AMBIGUOUS_COLUMNS');
    assert.ok(stored[0].failure_reason.length > 0);
    assert.equal(stored[0].filename, 'meridian.csv');
    assert.equal(stored[0].created_by, 'manager@carein.ai');
    assert.match(stored[0].file_sha256, /^[0-9a-f]{64}$/);

    // A failed batch has NO rows — the CHECK enforces it, and nothing tried.
    assert.equal(stored[0].row_count, 0);
    assert.equal(app.db.table('fees_import_row').length, 0);

    // The batch comes back on the refusal so the client can link to it.
    assert.equal(res.body.batch.batchId, stored[0].batch_id);
    assert.equal(res.body.batch.status, 'failed');

    // The failure is audited too: a file that would not parse is still a file
    // somebody uploaded.
    const audit = auditRows(app.db);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'CREATE');
    assert.equal(audit[0].resource_type, 'fees_import_batch');
    assert.equal(audit[0].resource_id, stored[0].batch_id);
    assert.equal(audit[0].result, 'ERROR');
    assert.equal(audit[0].office, 'roland');
  });
});

// ─── The success path ───────────────────────────────────────────────────────

test('a clean PDF is parsed, persisted, and returned from what the database gave back', async () => {
  await withApp({}, async (app) => {
    const res = await post(app, cleanPdf(), 'northstar-2027.pdf', PDF);

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.batch.status, 'parsed');
    assert.equal(res.body.batch.sourceType, 'pdf');
    assert.equal(res.body.batch.rowCount, 6);
    assert.equal(res.body.batch.warningCount, 0);
    assert.equal(res.body.batch.failureReason, null, 'present and null, never absent');
    assert.equal(res.body.batch.failureCode, null);

    // Fees are cents on the wire, not dollars.
    const crown = res.body.rows.find((r) => r.procCode === 'D2740');
    assert.equal(crown.feeCents, 115000);
    assert.equal(Number.isInteger(crown.feeCents), true);

    // Every returned row carries a row_id the database minted — which is what
    // makes this a read-back rather than an echo of the parser's own array.
    for (const row of res.body.rows) {
      assert.match(row.rowId, /^[0-9a-f-]{36}$/);
    }
    assert.equal(app.db.table('fees_import_row').length, 6);

    const audit = auditRows(app.db);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].result, 'SUCCESS');
  });
});

test('a CSV goes through the same rail and lands with source_type csv', async () => {
  await withApp({}, async (app) => {
    const res = await post(app, cleanCsv(), 'northstar-2027.csv', CSV);
    assert.equal(res.status, 201);
    assert.equal(res.body.batch.sourceType, 'csv');
    assert.equal(res.body.batch.rowCount, 5);
  });
});

test('warnings survive the round trip, on the rows AND counted on the batch', async () => {
  await withApp({}, async (app) => {
    const res = await post(app, fx.syntheticFeePdf(fx.PDF_MULTI_COLUMN), 'tiers.pdf', PDF);

    assert.equal(res.status, 201);
    assert.equal(res.body.batch.rowCount, 2);
    // Counting the file-level array alone would report 0 here, which is the
    // case that matters most: a clean-LOOKING file where every row is flagged.
    assert.equal(res.body.batch.warningCount, 2);

    const crown = res.body.rows.find((r) => r.procCode === 'D2740');
    const flag = crown.warnings.find((w) => w.code === 'ambiguous_amount');
    assert.ok(flag, 'the row carries its own warning, read back out of jsonb');
    assert.match(crown.rawLine, /805\.00/, 'and the line, so the flag is reviewable');
  });
});

test('a file-level warning lands on the batch, not on a row', async () => {
  await withApp({}, async (app) => {
    const res = await post(app, fx.syntheticFeePdf(fx.PDF_MULTIPLE_CODES), 'radiographs.pdf', PDF);

    assert.equal(res.status, 201);
    assert.equal(res.body.batch.rowCount, 1, 'only the unambiguous line became a row');
    const flag = res.body.batch.warnings.find((w) => w.code === 'multiple_codes_on_line');
    assert.ok(flag);
    assert.match(flag.message, /D0210, D0220, D0230/);
  });
});

// ─── The upload rail's own refusals ─────────────────────────────────────────

test('an .xlsx is refused BEFORE anything is stored — there is no lane to attempt', async () => {
  await withApp({}, async (app) => {
    const res = await post(app, Buffer.from('PK\u0003\u0004 not a schedule'), 'fees.xlsx', PDF);
    assert.equal(res.status, 415);
    assert.equal(res.body.code, 'UNSUPPORTED_FILE_TYPE');
    // source_type is NOT NULL with a CHECK, so a batch for an .xlsx could not
    // be written anyway — the schema agrees with this refusal.
    assert.equal(app.db.table('fees_import_batch').length, 0);
    assert.equal(auditRows(app.db).length, 0);
  });
});

test('a CSV renamed .pdf is refused by its magic bytes, and the refusal IS recorded', async () => {
  await withApp({}, async (app) => {
    const res = await post(app, cleanCsv(), 'schedule.pdf', PDF);
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'WRONG_FILE_TYPE');
    // Unlike the .xlsx above, this one HAS a lane and failed in it, so it is a
    // parse failure and gets a batch. The distinction is the point.
    assert.equal(app.db.table('fees_import_batch').length, 1);
    assert.equal(app.db.table('fees_import_batch')[0].status, 'failed');
  });
});

test('no file, an empty file and a tiny file are each refused by name', async () => {
  await withApp({}, async (app) => {
    const none = await api(app.baseUrl, 'POST', '/api/fees/imports?office=roland', {
      body: new FormData(),
    });
    assert.equal(none.status, 400);
    assert.equal(none.body.code, 'NO_FILE');

    const tiny = await post(app, Buffer.from('D0120'), 'tiny.csv', CSV);
    assert.equal(tiny.status, 400);
    assert.equal(tiny.body.code, 'FILE_TOO_SMALL');

    assert.equal(app.db.table('fees_import_batch').length, 0);
  });
});

test('a filename cannot escape into a path or forge a log line', async () => {
  await withApp({}, async (app) => {
    const res = await post(app, cleanCsv(), '../../etc/passwd\n[INFO] fake.csv', CSV);
    assert.equal(res.status, 201);
    const stored = app.db.table('fees_import_batch')[0].filename;
    assert.equal(stored.includes('/'), false);
    assert.equal(stored.includes('\\'), false);
    assert.equal(stored.includes('\n'), false);
  });
});

// ─── Office scoping ─────────────────────────────────────────────────────────

test('every route refuses a missing, unknown or system office', async () => {
  await withApp({}, async (app) => {
    for (const query of ['', '?office=', '?office=unknown', '?office=ROLAND', '?office=smith']) {
      const upload = await post(app, cleanCsv(), 'x.csv', CSV, query);
      assert.equal(upload.status, 400, `POST ${query}`);
      assert.equal(upload.body.code, 'INVALID_OFFICE');

      const list = await api(app.baseUrl, 'GET', `/api/fees/imports${query}`);
      assert.equal(list.status, 400, `GET ${query}`);
      assert.equal(list.body.code, 'INVALID_OFFICE');
    }
    // 'unknown' in particular: officeAgents carries it as a bucket for unmapped
    // Mango lines. It names no practice, so a payer contract cannot be filed
    // under it.
    assert.equal(app.db.table('fees_import_batch').length, 0);
  });
});

test("THE OTHER STAR: one office cannot read the other's import, even by id", async () => {
  await withApp({}, async (app) => {
    const created = await post(app, cleanCsv(), 'roland.csv', CSV, '?office=roland');
    assert.equal(created.status, 201);
    const { batchId } = created.body.batch;

    // Indistinguishable from a batch that does not exist — which is the correct
    // answer, not a leak to paper over. The office is in the WHERE, so the row
    // is never fetched rather than fetched-then-rejected.
    const crossed = await api(app.baseUrl, 'GET', `/api/fees/imports/${batchId}?office=valley`);
    assert.equal(crossed.status, 404);
    assert.equal(crossed.body.code, 'BATCH_NOT_FOUND');

    const valleyList = await api(app.baseUrl, 'GET', '/api/fees/imports?office=valley');
    assert.equal(valleyList.body.batches.length, 0);

    const rolandList = await api(app.baseUrl, 'GET', '/api/fees/imports?office=roland');
    assert.equal(rolandList.body.batches.length, 1);
  });
});

test('the body cannot redirect an import to another office', async () => {
  await withApp({}, async (app) => {
    // Office comes from the validated query param and nothing else. A body
    // field is not an assertion here — it is simply not read.
    const form = filePart(cleanCsv(), 'x.csv', CSV);
    form.append('office', 'valley');
    form.append('office_id', 'valley');
    const res = await api(app.baseUrl, 'POST', '/api/fees/imports?office=roland', { body: form });

    assert.equal(res.status, 201);
    assert.equal(res.body.batch.office, 'roland');
    assert.equal(app.db.table('fees_import_batch')[0].office, 'roland');
    for (const row of app.db.table('fees_import_row')) assert.equal(row.office, 'roland');
  });
});

// ─── The gates ──────────────────────────────────────────────────────────────

test('SHIPS DARK: an unentitled tenant gets 403 MODULE_NOT_ENTITLED on every route', async () => {
  await withApp({ modules: [] }, async (app) => {
    const upload = await post(app, cleanCsv(), 'x.csv', CSV);
    assert.equal(upload.status, 403);
    assert.equal(upload.body.error, 'MODULE_NOT_ENTITLED');
    assert.equal(upload.body.module, 'fees');

    for (const path of ['/api/fees/imports?office=roland', '/api/fees/imports/x?office=roland']) {
      const res = await api(app.baseUrl, 'GET', path);
      assert.equal(res.status, 403, path);
      assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
    }
    assert.equal(app.db.table('fees_import_batch').length, 0);
  });
});

test('the module guard runs BEFORE the office guard — entitlement is not probeable', async () => {
  // A 400 INVALID_OFFICE from an unentitled tenant would confirm the module
  // exists and that the caller's office was wrong, which is more than a tenant
  // without the product should learn.
  await withApp({ modules: [] }, async (app) => {
    const res = await api(app.baseUrl, 'GET', '/api/fees/imports');
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
  });
});

test('only admin and office reach this module — every other role is refused outright', async () => {
  // The permission map grants fees.read/fees.write to admin and office and to
  // nobody else. `rcm_biller` is a DEFERRED decision rather than an oversight —
  // see the fees block in config/permissions.js, and rcmGuard.test.js:273,
  // which pins that role to RCM actions only.
  for (const role of ['tc', 'hygiene', 'reviewer', 'rcm_biller', 'staff']) {
    await withApp({ role }, async (app) => {
      const list = await api(app.baseUrl, 'GET', '/api/fees/imports?office=roland');
      assert.equal(list.status, 403, `${role} must not read fee schedules`);

      const upload = await post(app, cleanCsv(), 'x.csv', CSV);
      assert.equal(upload.status, 403, `${role} must not import a fee schedule`);
      assert.equal(app.db.table('fees_import_batch').length, 0);
    });
  }
});

test('office reaches the whole surface, and the write gate applies BY METHOD', async () => {
  // The mount is requireReadWrite, so a future GET needs no decoration and a
  // future POST cannot land on the read tier by omission.
  await withApp({ role: 'office' }, async (app) => {
    const upload = await post(app, cleanCsv(), 'x.csv', CSV);
    assert.equal(upload.status, 201);
    const list = await api(app.baseUrl, 'GET', '/api/fees/imports?office=roland');
    assert.equal(list.status, 200);
  });
});

test('an anonymous request never reaches the module at all', async () => {
  await withApp({}, async (app) => {
    const res = await api(app.baseUrl, 'GET', '/api/fees/imports?office=roland', { anon: true });
    assert.equal(res.status, 401);
  });
});

// ─── Reading back ───────────────────────────────────────────────────────────

test('the list returns batches newest first and does NOT carry their rows', async () => {
  await withApp({}, async (app) => {
    await post(app, cleanCsv(), 'first.csv', CSV);
    await post(app, cleanPdf(), 'second.pdf', PDF);

    const res = await api(app.baseUrl, 'GET', '/api/fees/imports?office=roland');
    assert.equal(res.status, 200);
    assert.equal(res.body.batches.length, 2);
    // A list of fifty schedules at four hundred rows each is twenty thousand
    // rows nobody asked for.
    for (const batch of res.body.batches) {
      assert.equal('rows' in batch, false);
      assert.ok(batch.rowCount > 0, 'the COUNT is there; the rows are not');
    }
  });
});

test('limit and offset are bounded rather than trusted', async () => {
  await withApp({}, async (app) => {
    await post(app, cleanCsv(), 'a.csv', CSV);
    for (const [query, expected] of [
      ['&limit=9999', 200],
      ['&limit=-1', 50],
      ['&limit=abc', 50],
      ['&limit=0', 0],
    ]) {
      const res = await api(app.baseUrl, 'GET', `/api/fees/imports?office=roland${query}`);
      assert.equal(res.body.limit, expected, query);
    }
  });
});

test('a batch reads back with every row, in the file\'s own order', async () => {
  await withApp({}, async (app) => {
    const created = await post(app, cleanPdf(), 'northstar.pdf', PDF);
    const res = await api(
      app.baseUrl,
      'GET',
      `/api/fees/imports/${created.body.batch.batchId}?office=roland`
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.batch.rowCount, 6);
    assert.deepEqual(
      res.body.rows.map((r) => r.procCode),
      ['D0120', 'D0150', 'D0210', 'D1110', 'D2740', 'D4341'],
      'source order, not insertion-race order'
    );
  });
});

test('a malformed batch id is not found, not a 500', async () => {
  // Letting it reach Postgres produces `invalid input syntax for type uuid` →
  // a 500, so a malformed id and a real-looking missing one would answer
  // differently and the shape of the error would tell a prober which.
  //
  // A path-traversal id is deliberately NOT in this list: `..` segments are
  // resolved by the URL parser before the request is sent, so such a request
  // never reaches this router and proving otherwise here would be proving
  // something about undici. The ids below all reach the handler.
  await withApp({}, async (app) => {
    for (const id of [
      'not-a-uuid',
      '1',
      'abc',
      '00000000-0000-0000-0000-00000000000', // one digit short
      'gggggggg-0000-0000-0000-000000000000', // right shape, not hex
    ]) {
      const res = await api(app.baseUrl, 'GET', `/api/fees/imports/${id}?office=roland`);
      assert.equal(res.status, 404, id);
      assert.equal(res.body.code, 'BATCH_NOT_FOUND', id);
    }

    // And a well-formed id that simply does not exist answers identically, so
    // the shape of the response tells a prober nothing about which it was.
    const missing = await api(
      app.baseUrl,
      'GET',
      '/api/fees/imports/2f1a9c44-0000-4000-8000-000000000000?office=roland'
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'BATCH_NOT_FOUND');
  });
});

// ─── Atomicity ──────────────────────────────────────────────────────────────

test('a failure partway through the write leaves NOTHING, not a half-stored preview', async () => {
  // A committed batch saying `rowCount: 412` beside 300 stored rows is a
  // preview an office scrolls to the bottom of and believes they have seen.
  const db = new FakeFeesDb();
  db.failWhen = (sql) => /^INSERT INTO fees_import_row/i.test(sql);

  await withApp({ db }, async (app) => {
    const res = await post(app, cleanPdf(), 'northstar.pdf', PDF);
    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'INTERNAL_ERROR');

    assert.equal(app.db.table('fees_import_batch').length, 0, 'the batch rolled back with the rows');
    assert.equal(app.db.table('fees_import_row').length, 0);
    // Nothing was reserved and no money moved, so the upload can simply be
    // re-sent — and no audit row claims a batch that does not exist.
    assert.equal(auditRows(app.db).length, 0);
  });
});

test('success is reported only after the rows are in — never from the parser\'s arrays', async () => {
  // The response is built from what insertBatch read back. If it were built
  // from the parse, this test could not tell the difference; the row ids are
  // what make it possible to.
  await withApp({}, async (app) => {
    const res = await post(app, cleanPdf(), 'northstar.pdf', PDF);
    const storedIds = app.db
      .table('fees_import_row')
      .map((r) => r.row_id)
      .sort();
    assert.deepEqual(
      res.body.rows.map((r) => r.rowId).sort(),
      storedIds,
      'every returned row is a row that exists in the database'
    );
  });
});
