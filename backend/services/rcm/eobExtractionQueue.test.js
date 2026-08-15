'use strict';

/**
 * The extraction queue seam.
 *
 * This is the file that has to stay honest about what an in-process queue is
 * and is not, because the slice brief asked for BullMQ and the platform has no
 * Redis to put behind it. What is pinned here is the part that makes the swap
 * cheap and the behavior identical under it:
 *
 *   - jobs are PLAIN SERIALIZABLE DATA (nothing request-scoped rides along),
 *   - the runner is serial and FIFO, like a single-worker BullMQ queue,
 *   - a deferred job is PARKED, never dropped,
 *   - a handler that throws does not stall the queue behind it.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queue = require('./eobExtractionQueue');
const budget = require('./extractionBudget');

const JOB = Object.freeze({
  tenantId: 'T1',
  tenantSlug: 'carein',
  office: 'roland',
  uploadId: 'upload-1',
});

function withTempState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-queue-'));
  const prior = { ...process.env };
  process.env.CALLSTORE_DIR = dir;
  budget._resetForTests();
  queue._resetForTests();
  return Promise.resolve(fn()).finally(() => {
    queue._resetForTests();
    budget._resetForTests();
    for (const k of Object.keys(process.env)) if (!(k in prior)) delete process.env[k];
    Object.assign(process.env, prior);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('a job is plain serializable data — nothing request-scoped survives', async () => {
  await withTempState(async () => {
    const seen = [];
    queue._setHandler(async (job) => {
      seen.push(job);
      return { status: 'extracted' };
    });

    // Extra properties are dropped: what a Redis payload would carry is exactly
    // the four strings, so a handler must never come to depend on more.
    queue.enqueue({ ...JOB, req: { user: 'x' }, pool: {}, buffer: Buffer.alloc(4) });
    await queue.drain();

    assert.equal(seen.length, 1);
    assert.deepEqual(Object.keys(seen[0]).sort(), ['office', 'tenantId', 'tenantSlug', 'uploadId']);
    assert.deepEqual(seen[0], JOB);
    assert.equal(JSON.parse(JSON.stringify(seen[0])).uploadId, 'upload-1');
  });
});

test('a job missing any required field is refused at enqueue, not at run time', async () => {
  await withTempState(async () => {
    for (const key of ['tenantId', 'tenantSlug', 'office', 'uploadId']) {
      const broken = { ...JOB, [key]: '' };
      assert.throws(() => queue.enqueue(broken), new RegExp(key), `missing ${key}`);
    }
  });
});

test('jobs run one at a time, in order', async () => {
  await withTempState(async () => {
    const order = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    queue._setHandler(async (job) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setImmediate(r));
      order.push(job.uploadId);
      concurrent--;
      return { status: 'extracted' };
    });

    for (const id of ['a', 'b', 'c']) queue.enqueue({ ...JOB, uploadId: id });
    await queue.drain();

    assert.deepEqual(order, ['a', 'b', 'c'], 'FIFO, like a single-worker BullMQ queue');
    assert.equal(maxConcurrent, 1, 'concurrency 1 — extraction is metered, not parallelized');
  });
});

test('enqueueing the same upload twice runs it once', async () => {
  await withTempState(async () => {
    let runs = 0;
    queue._setHandler(async () => {
      runs++;
      // Hold the runner open so the second enqueue lands while the first is
      // still queued — the double-click case.
      await new Promise((r) => setTimeout(r, 5));
      return { status: 'extracted' };
    });

    queue.enqueue(JOB);
    queue.enqueue(JOB);
    await queue.drain();
    assert.equal(runs, 1, 'a double submit must not extract twice');
  });
});

test('a deferred job is PARKED, not dropped, and resumes when the budget allows', async () => {
  await withTempState(async () => {
    process.env.RCM_EXTRACTION_MAX_CENTS_PER_DAY = '1';
    budget.charge({ prompt_tokens: 0, completion_tokens: 100_000, total_tokens: 100_000 });
    assert.equal(budget.check().allowed, false, 'precondition: tripped');

    let attempts = 0;
    queue._setHandler(async () => {
      attempts++;
      return budget.check().allowed
        ? { status: 'extracted' }
        : { status: 'deferred', resetsAt: budget.check().resetsAt };
    });

    queue.enqueue(JOB);
    await queue.drain();

    assert.equal(attempts, 1);
    assert.deepEqual(queue.stats(), { pending: 0, deferred: 1, running: false }, 'parked, not lost');

    // Resuming while still tripped must NOT burn the parked job.
    assert.equal(queue.resumeDeferred(), 0);
    assert.equal(queue.stats().deferred, 1);

    // The day rolls (here: the cap is raised, through the same counter).
    process.env.RCM_EXTRACTION_MAX_CENTS_PER_DAY = '1000';
    assert.equal(queue.resumeDeferred(), 1);
    await queue.drain();

    assert.equal(attempts, 2);
    assert.deepEqual(queue.stats(), { pending: 0, deferred: 0, running: false });
  });
});

test('a handler that throws does not stall the jobs behind it', async () => {
  await withTempState(async () => {
    const ran = [];
    queue._setHandler(async (job) => {
      ran.push(job.uploadId);
      if (job.uploadId === 'boom') throw new Error('handler bug');
      return { status: 'extracted' };
    });

    queue.enqueue({ ...JOB, uploadId: 'boom' });
    queue.enqueue({ ...JOB, uploadId: 'after' });
    await queue.drain();

    assert.deepEqual(ran, ['boom', 'after'], 'one bad job must not take the queue with it');
  });
});

test('stats report the honest depth', async () => {
  await withTempState(async () => {
    assert.deepEqual(queue.stats(), { pending: 0, deferred: 0, running: false });
  });
});
