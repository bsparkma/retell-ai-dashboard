'use strict';

/**
 * W-21 — the needs-attention predicate learns `outcome_unknown`.
 *
 * `attentionFor` is what puts a remittance on somebody's list. A plan whose
 * write may or may not have reached Open Dental is the last thing that should
 * sit quietly on a list nobody opens — and it must not be reported as
 * `claims_queued`, which reads as "nothing has been written yet".
 *
 * Pure: the batch, its claims and the plan statuses in, the verdict out.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { attentionFor, POSTING_NEEDS_SOMEBODY } = require('../routes/rcm/remittances');

const READY_BATCH = { status: 'ready', flags: [] };
const QUEUED_CLAIM = {
  needsReviewReasons: [],
  odMatchStatus: 'confirmed',
  reviewedAt: '2026-10-01T12:00:00Z',
  postingQueueId: 'b4f0e2c1-9a3d-4e58-8f21-7c6d5a4b3e29',
};

test('W-21: an outcome_unknown plan puts its remittance on the list as posting_failed', () => {
  const verdict = attentionFor(READY_BATCH, [QUEUED_CLAIM], {
    hasQueue: true,
    queueStatuses: ['outcome_unknown'],
  });
  assert.equal(verdict.needsAttention, true);
  assert.ok(verdict.reasons.includes('posting_failed'), JSON.stringify(verdict));
  assert.ok(
    !verdict.observations.includes('claims_queued'),
    'an unknown outcome must never read as "queued, nothing written"'
  );
});

test('W-21: the obligation list is the one both readers share, and it carries every unfinished word', () => {
  assert.deepEqual(
    [...POSTING_NEEDS_SOMEBODY].sort(),
    ['blocked', 'failed', 'outcome_unknown', 'partially_posted']
  );
  for (const status of POSTING_NEEDS_SOMEBODY) {
    const verdict = attentionFor(READY_BATCH, [QUEUED_CLAIM], {
      hasQueue: true,
      queueStatuses: [status],
    });
    assert.ok(verdict.reasons.includes('posting_failed'), status);
  }
});
