'use strict';

/**
 * The startup sweep.
 *
 * A row left at `processing` after a restart claims work is happening when the
 * in-process queue that owned it no longer exists. That is a lie, and a worse
 * one than a failure: a failure tells the poster to try again; a permanent
 * `processing` tells them to wait for something that will never come.
 *
 * What is pinned here:
 *   - `processing` → `failed`, with a reason that names the restart and the fix;
 *   - NOTHING else is touched — an `uploaded` row waiting on the cost cap, an
 *     `extracted` proposal, and an already-`failed` row all survive verbatim;
 *   - every active tenant is swept, and one broken tenant does not stop the rest;
 *   - it NEVER throws, because it must never be able to abort boot;
 *   - it is wired ABOVE `server.listen()`, which is what stops it racing an
 *     extraction this process started.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { FakeRcmDb } = require('../../routes/rcm/rcmTestUtils');
const { sweepInterruptedExtractions, INTERRUPTED_REASON } = require('./eobStartupSweep');

/** Uploads in every status, so the sweep's blast radius is visible. */
function seededDb() {
  return new FakeRcmDb().seed('rcm_eob_uploads', [
    { upload_id: 'u-processing', office_id: 'roland', status: 'processing', error_message: null, processed_at: null },
    { upload_id: 'u-processing-2', office_id: 'valley', status: 'processing', error_message: null, processed_at: null },
    { upload_id: 'u-uploaded', office_id: 'roland', status: 'uploaded', error_message: 'Extraction paused — the daily cost cap of $10.00 is used up.' },
    { upload_id: 'u-extracted', office_id: 'roland', status: 'extracted', result_claim_id: 'claim-1', error_message: null },
    { upload_id: 'u-failed', office_id: 'valley', status: 'failed', error_message: 'The extraction service could not be reached. Try again.' },
  ]);
}

const row = (db, id) => db.table('rcm_eob_uploads').find((r) => r.upload_id === id);

/** Stub deps: one active tenant over `db`. */
function deps(db, { tenants, poolFor } = {}) {
  return {
    registry: {
      listTenants: async () =>
        tenants || [{ tenant_id: 'T1', slug: 'carein', status: 'active' }],
    },
    tenantDb: {
      getTenantPool: async (tenantId) => (poolFor ? poolFor(tenantId) : db),
    },
  };
}

test('an interrupted extraction becomes failed, with a reason naming the restart', async () => {
  const db = seededDb();
  const result = await sweepInterruptedExtractions(deps(db));

  assert.deepEqual(result, { swept: 2, tenants: 1, skipped: 0 });

  for (const id of ['u-processing', 'u-processing-2']) {
    const swept = row(db, id);
    assert.equal(swept.status, 'failed');
    assert.equal(swept.error_message, INTERRUPTED_REASON);
    assert.ok(swept.processed_at instanceof Date, 'the attempt is finished, so stamp when');
  }

  assert.match(INTERRUPTED_REASON, /restart/i);
  assert.match(INTERRUPTED_REASON, /Upload it again/i, 'and it must say what to do next');
});

test('nothing but processing is touched', async () => {
  const db = seededDb();
  const before = {
    uploaded: { ...row(db, 'u-uploaded') },
    extracted: { ...row(db, 'u-extracted') },
    failed: { ...row(db, 'u-failed') },
  };

  await sweepInterruptedExtractions(deps(db));

  // An `uploaded` row is waiting on the cost cap, not stuck — sweeping it would
  // turn a pause into a failure and lose the document's place in the queue.
  assert.deepEqual(row(db, 'u-uploaded'), before.uploaded);
  // An `extracted` row has a committed proposal behind it.
  assert.deepEqual(row(db, 'u-extracted'), before.extracted);
  // An already-failed row keeps its OWN reason, not the interrupted one.
  assert.deepEqual(row(db, 'u-failed'), before.failed);
});

test('it is idempotent — a second boot sweeps nothing', async () => {
  const db = seededDb();
  await sweepInterruptedExtractions(deps(db));
  const second = await sweepInterruptedExtractions(deps(db));
  assert.equal(second.swept, 0);
  assert.equal(row(db, 'u-processing').error_message, INTERRUPTED_REASON);
});

test('a clean shutdown leaves nothing to sweep', async () => {
  const db = new FakeRcmDb().seed('rcm_eob_uploads', [
    { upload_id: 'u1', office_id: 'roland', status: 'extracted' },
    { upload_id: 'u2', office_id: 'roland', status: 'uploaded' },
  ]);
  const result = await sweepInterruptedExtractions(deps(db));
  assert.deepEqual(result, { swept: 0, tenants: 1, skipped: 0 });
});

test('every ACTIVE tenant is swept; inactive ones are left alone', async () => {
  const a = seededDb();
  const b = seededDb();
  const result = await sweepInterruptedExtractions(
    deps(null, {
      tenants: [
        { tenant_id: 'T1', slug: 'alpha', status: 'active' },
        { tenant_id: 'T2', slug: 'beta', status: 'active' },
        { tenant_id: 'T3', slug: 'retired', status: 'suspended' },
      ],
      poolFor: (id) => (id === 'T1' ? a : id === 'T2' ? b : (() => { throw new Error('T3 must not be touched'); })()),
    })
  );
  assert.deepEqual(result, { swept: 4, tenants: 2, skipped: 0 });
  assert.equal(row(a, 'u-processing').status, 'failed');
  assert.equal(row(b, 'u-processing').status, 'failed');
});

test('one unreachable tenant does not stop the others, and does not throw', async () => {
  const healthy = seededDb();
  const result = await sweepInterruptedExtractions(
    deps(null, {
      tenants: [
        { tenant_id: 'T1', slug: 'broken', status: 'active' },
        { tenant_id: 'T2', slug: 'healthy', status: 'active' },
      ],
      poolFor: (id) => {
        if (id === 'T1') throw new Error('ECONNREFUSED');
        return healthy;
      },
    })
  );
  assert.deepEqual(result, { swept: 2, tenants: 2, skipped: 1 });
  assert.equal(row(healthy, 'u-processing').status, 'failed');
});

test('an unlistable registry is survivable — housekeeping must never abort boot', async () => {
  const result = await sweepInterruptedExtractions({
    registry: {
      listTenants: async () => {
        throw new Error('control DB unreachable');
      },
    },
    tenantDb: { getTenantPool: async () => { throw new Error('unreachable'); } },
  });
  assert.deepEqual(result, { swept: 0, tenants: 0, skipped: 0 });
});

test('server.js runs the sweep ABOVE server.listen()', () => {
  // The ordering IS the safety property: after listen(), the sweep could mark a
  // 'processing' row this very process had just created. A comment saying so is
  // not enough — the TC voice-handoff slice taught this repo that a mount-order
  // constraint living only in prose is a constraint waiting to be broken.
  const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
  const sweepIdx = src.indexOf('sweepInterruptedExtractions()');
  const listenIdx = src.indexOf('server.listen(PORT');
  assert.ok(sweepIdx > 0, 'server.js must run the EOB startup sweep');
  assert.ok(listenIdx > 0, 'server.js must listen');
  assert.ok(
    sweepIdx < listenIdx,
    'the EOB startup sweep must run BEFORE server.listen() — see services/rcm/eobStartupSweep.js'
  );
});
